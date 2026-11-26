package assistant

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
	"weak"

	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
)

// maxRestartRecoveryAttempts caps consecutive automatic restart self-healing retries per supervised
// task across restarts before escalating to supervision (#15733).
const maxRestartRecoveryAttempts = 2

// Sliding-window storm guardrails per (machine, session) so rapid restart loops cannot burn tokens
// indefinitely even if attempts reset between cycles. Vars so tests override them without sleeps.
var (
	restartAutoResumeWindow      = time.Hour
	maxRestartAutoResumesPerHour = 3
)

// runtimeBootEpoch returns this Service's stable per-process boot epoch, initializing it lazily
// for zero-value Service{} instances in tests (#16099).
func (s *Service) runtimeBootEpoch() string {
	if s == nil {
		return ""
	}
	if p := s.todosV2BootEpoch.Load(); p != nil && *p != "" {
		return *p
	}
	gen := "boot_" + randomHex(8)
	if s.todosV2BootEpoch.CompareAndSwap(nil, &gen) {
		return gen
	}
	if p := s.todosV2BootEpoch.Load(); p != nil && *p != "" {
		return *p
	}
	return gen
}

// setBootEpoch overrides this Service's boot epoch (tests).
func (s *Service) setBootEpoch(epoch string) {
	if s == nil {
		return
	}
	v := strings.TrimSpace(epoch)
	s.todosV2BootEpoch.Store(&v)
}

// startupRecoveryProgress tracks per-boot machine sweep progress, node-restart cycle idempotency,
// and per-session hourly storm limits without adding fields to Service (#16227).
type startupRecoveryProgress struct {
	mu            sync.Mutex
	epoch         string
	sweptMachines map[string]bool
	inFlight      map[string]bool
	lastSweptFlag bool
	nodeCycleDone map[string]bool
	hourlyResumes map[[2]string][]time.Time
	clock         func() time.Time
}

func (p *startupRecoveryProgress) markSweptFlag(epoch string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.epoch = epoch
	p.lastSweptFlag = true
}

func (p *startupRecoveryProgress) now() time.Time {
	p.mu.Lock()
	clk := p.clock
	p.mu.Unlock()
	if clk != nil {
		return clk().UTC()
	}
	return time.Now().UTC()
}

func (p *startupRecoveryProgress) pruneHourlyLocked(key [2]string, now time.Time) []time.Time {
	cutoff := now.Add(-restartAutoResumeWindow)
	times := p.hourlyResumes[key]
	if len(times) == 0 {
		return nil
	}
	kept := times[:0]
	for _, ts := range times {
		if !ts.Before(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) == 0 {
		delete(p.hourlyResumes, key)
		return nil
	}
	p.hourlyResumes[key] = kept
	return kept
}

func (p *startupRecoveryProgress) hourlyCount(key [2]string, now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.pruneHourlyLocked(key, now))
}

func (p *startupRecoveryProgress) recordHourlyResume(key [2]string, now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.pruneHourlyLocked(key, now)
	kept = append(kept, now)
	p.hourlyResumes[key] = kept
	return len(kept)
}

func (p *startupRecoveryProgress) nodeCycleHandled(cycleKey string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nodeCycleDone[cycleKey]
}

func (p *startupRecoveryProgress) markNodeCycleHandled(cycleKey string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.nodeCycleDone == nil {
		p.nodeCycleDone = make(map[string]bool)
	}
	p.nodeCycleDone[cycleKey] = true
}

// startupRecoveryProgressRegistry attaches per-Service startup sweep state without modifying
// Service fields and cleans up automatically when Service is garbage-collected.
var startupRecoveryProgressRegistry = struct {
	mu    sync.Mutex
	bySvc map[weak.Pointer[Service]]*startupRecoveryProgress
}{
	bySvc: make(map[weak.Pointer[Service]]*startupRecoveryProgress),
}

func (s *Service) startupRecoveryProgress() *startupRecoveryProgress {
	wp := weak.Make(s)
	startupRecoveryProgressRegistry.mu.Lock()
	defer startupRecoveryProgressRegistry.mu.Unlock()
	if prog, ok := startupRecoveryProgressRegistry.bySvc[wp]; ok {
		return prog
	}
	prog := &startupRecoveryProgress{
		sweptMachines: make(map[string]bool),
		inFlight:      make(map[string]bool),
		nodeCycleDone: make(map[string]bool),
		hourlyResumes: make(map[[2]string][]time.Time),
	}
	startupRecoveryProgressRegistry.bySvc[wp] = prog
	runtime.AddCleanup(s, func(key weak.Pointer[Service]) {
		startupRecoveryProgressRegistry.mu.Lock()
		delete(startupRecoveryProgressRegistry.bySvc, key)
		startupRecoveryProgressRegistry.mu.Unlock()
	}, wp)
	return prog
}

func (s *Service) setRestartRecoveryClock(fn func() time.Time) {
	if s == nil {
		return
	}
	prog := s.startupRecoveryProgress()
	prog.mu.Lock()
	prog.clock = fn
	prog.mu.Unlock()
}

func (s *Service) recoveryNow() time.Time {
	if s == nil {
		return time.Now().UTC()
	}
	return s.startupRecoveryProgress().now()
}

// isRecoveryMachineOffline reports whether machineID is explicitly known to be offline/unreachable
// from the hub's device list. When no device list is available (e.g. direct unit tests), it returns
// false and defers to s.sessions(ctx, machineID) reachability.
func (s *Service) isRecoveryMachineOffline(ctx context.Context, machineID string) bool {
	if s == nil {
		return false
	}
	devices := s.devices(ctx)
	if len(devices) == 0 {
		return false
	}
	want := cmp.Or(s.canonical(machineID), strings.TrimSpace(machineID))
	for _, d := range devices {
		did := cmp.Or(s.canonical(d.ID), strings.TrimSpace(d.ID))
		if did == want {
			return !d.Online && !d.Reachable
		}
	}
	return false
}

// maybeRunStartupRestartRecovery executes startup restart self-healing per connected machine
// at most once per process boot when restart_auto_resume is enabled (#16099, #16227).
func (s *Service) maybeRunStartupRestartRecovery(ctx context.Context, lists machineSessions) {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() || s.todosV2RecoverySwept.Load() {
		return
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return
	}
	states, err := st.ListTodoRecoveryStates(ctx)
	if err != nil {
		s.logf("restart_auto_resume action=error stage=list_states err=%v", err)
		return
	}
	bootEpoch := s.runtimeBootEpoch()
	prog := s.startupRecoveryProgress()

	needMachines := make(map[string]struct{})
	for _, rec := range states {
		if rec.LastActiveBootEpoch != "" && rec.LastActiveBootEpoch != bootEpoch && rec.MachineID != "" {
			needMachines[rec.MachineID] = struct{}{}
		}
	}
	if len(needMachines) == 0 {
		for _, l := range lists {
			if l.err == nil && len(l.list) > 0 {
				if s.todosV2RecoverySwept.CompareAndSwap(false, true) {
					prog.markSweptFlag(bootEpoch)
				}
				return
			}
		}
		if s.fleetUp.Load() {
			if s.todosV2RecoverySwept.CompareAndSwap(false, true) {
				prog.markSweptFlag(bootEpoch)
			}
		}
		return
	}

	var toCheck []string
	hasPending := false
	prog.mu.Lock()
	if prog.epoch != bootEpoch || prog.lastSweptFlag {
		prog.epoch = bootEpoch
		prog.sweptMachines = make(map[string]bool)
		prog.inFlight = make(map[string]bool)
		prog.lastSweptFlag = false
	}
	for mid := range needMachines {
		if prog.sweptMachines[mid] {
			continue
		}
		if prog.inFlight[mid] {
			hasPending = true
			continue
		}
		toCheck = append(toCheck, mid)
	}
	prog.mu.Unlock()
	slices.Sort(toCheck)

	if lists == nil {
		lists = machineSessions{}
	}
	readyCandidates := make(map[string]struct{})
	var sessions []proto.Session
	seen := make(map[[2]string]struct{})
	for _, mid := range toCheck {
		if s.isRecoveryMachineOffline(ctx, mid) {
			hasPending = true
			continue
		}
		l, ok := lists[mid]
		if !ok {
			l.list, l.err = s.sessions(ctx, mid)
			lists[mid] = l
		}
		if l.err != nil {
			// Node not synced/reachable yet; skip only this machine and retry on reconnect/later tick.
			hasPending = true
			continue
		}
		readyCandidates[mid] = struct{}{}
		for _, sess := range l.list {
			if sess.MachineID == "" {
				sess.MachineID = mid
			}
			key := [2]string{sess.MachineID, sess.SessionID}
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			sessions = append(sessions, sess)
		}
	}

	if len(readyCandidates) > 0 {
		readyMachines := make(map[string]struct{}, len(readyCandidates))
		prog.mu.Lock()
		if prog.epoch != bootEpoch {
			prog.mu.Unlock()
			return
		}
		for mid := range readyCandidates {
			if prog.sweptMachines[mid] || prog.inFlight[mid] {
				continue
			}
			prog.inFlight[mid] = true
			readyMachines[mid] = struct{}{}
		}
		prog.mu.Unlock()

		if len(readyMachines) > 0 {
			_, sweepErr := s.runRestartRecoverySweepForMachines(ctx, bootEpoch, sessions, readyMachines)
			prog.mu.Lock()
			for mid := range readyMachines {
				delete(prog.inFlight, mid)
				if sweepErr == nil && prog.epoch == bootEpoch {
					prog.sweptMachines[mid] = true
				} else {
					hasPending = true
				}
			}
			prog.mu.Unlock()
			if sweepErr != nil {
				s.logf("restart_auto_resume action=error stage=startup_sweep err=%v", sweepErr)
			}
		}
	}

	if !hasPending {
		prog.mu.Lock()
		if prog.epoch == bootEpoch {
			allDone := true
			for mid := range needMachines {
				if !prog.sweptMachines[mid] || prog.inFlight[mid] {
					allDone = false
					break
				}
			}
			if allDone {
				s.todosV2RecoverySwept.Store(true)
				prog.lastSweptFlag = true
			}
		}
		prog.mu.Unlock()
	}
}

// maybeRunNodeRestartRecovery detects in-flight supervised task sessions cut off by a fast node
// service restart while the hub stayed up (same boot epoch, session now StatusInterrupted with
// StopCause == StopRestart) and resumes each at most once per node restart cycle.
func (s *Service) maybeRunNodeRestartRecovery(ctx context.Context, lists machineSessions) {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() {
		return
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return
	}
	states, err := st.ListTodoRecoveryStates(ctx)
	if err != nil || len(states) == 0 {
		return
	}
	bootEpoch := s.runtimeBootEpoch()
	needMachines := make(map[string]struct{})
	for _, rec := range states {
		if rec.LastActiveBootEpoch == bootEpoch && rec.MachineID != "" {
			needMachines[rec.MachineID] = struct{}{}
		}
	}
	if len(needMachines) == 0 {
		return
	}
	if lists == nil {
		lists = machineSessions{}
	}
	readyMachines := make(map[string]struct{}, len(needMachines))
	var sessions []proto.Session
	seen := make(map[[2]string]struct{})
	for mid := range needMachines {
		if s.isRecoveryMachineOffline(ctx, mid) {
			continue
		}
		l, ok := lists[mid]
		if !ok {
			l.list, l.err = s.sessions(ctx, mid)
			lists[mid] = l
		}
		if l.err != nil {
			continue
		}
		readyMachines[mid] = struct{}{}
		for _, sess := range l.list {
			if sess.MachineID == "" {
				sess.MachineID = mid
			}
			key := [2]string{sess.MachineID, sess.SessionID}
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			sessions = append(sessions, sess)
		}
	}
	if len(readyMachines) == 0 {
		return
	}
	if _, err := s.runNodeRestartRecoveryForMachines(ctx, bootEpoch, sessions, readyMachines); err != nil {
		s.logf("restart_auto_resume action=error stage=node_sweep err=%v", err)
	}
}

// onNodeReconnectedForRestartRecovery triggers prompt restart recovery for machine as soon as it
// reconnects, without waiting for the next superviseWatch tick or a 10-minute outage threshold.
func (s *Service) onNodeReconnectedForRestartRecovery(ctx context.Context, machine string) {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() {
		return
	}
	mid := cmp.Or(s.canonical(machine), strings.TrimSpace(machine))
	if mid == "" {
		return
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return
	}
	states, err := st.ListTodoRecoveryStates(ctx)
	if err != nil || len(states) == 0 {
		return
	}
	hasCrossEpoch := false
	hasSameEpoch := false
	bootEpoch := s.runtimeBootEpoch()
	for _, rec := range states {
		rmid := cmp.Or(s.canonical(rec.MachineID), strings.TrimSpace(rec.MachineID))
		if rmid != mid {
			continue
		}
		if rec.LastActiveBootEpoch != "" && rec.LastActiveBootEpoch != bootEpoch {
			hasCrossEpoch = true
		} else if rec.LastActiveBootEpoch == bootEpoch {
			hasSameEpoch = true
		}
	}
	if !hasCrossEpoch && !hasSameEpoch {
		return
	}
	list, err := s.sessions(ctx, mid)
	if err != nil {
		return
	}
	lists := machineSessions{mid: {list: list}}
	if hasCrossEpoch {
		s.maybeRunStartupRestartRecovery(ctx, lists)
	}
	if hasSameEpoch {
		s.maybeRunNodeRestartRecovery(ctx, lists)
	}
}

// restartRecoveryResult reports what a startup or node restart recovery sweep acted on.
type restartRecoveryResult struct {
	RecoveredTodoIDs []string
	EscalatedTodoIDs []string
	SkippedTodoIDs   []string
}

type todoRecoveryStore interface {
	RecordTodoActiveCheckpoint(ctx context.Context, row db.TodoRecoveryState) error
	GetTodoRecoveryState(ctx context.Context, todoID string) (db.TodoRecoveryState, bool, error)
	ListTodoRecoveryStates(ctx context.Context) ([]db.TodoRecoveryState, error)
	IncrementTodoRecoveryAttempts(ctx context.Context, todoID, newBootEpoch string, recoveredAt time.Time) (db.TodoRecoveryState, error)
	ResetTodoRecoveryState(ctx context.Context, todoID string, at time.Time) error
	DeleteTodoRecoveryState(ctx context.Context, todoID string) error
}

// memTodoRecoveryStore is the concurrency-safe fallback store used when Service runs against
// an in-memory test Store instead of Postgres *db.DB.
type memTodoRecoveryStore struct {
	mu   sync.Mutex
	rows map[string]db.TodoRecoveryState
}

func newMemTodoRecoveryStore() *memTodoRecoveryStore {
	return &memTodoRecoveryStore{rows: make(map[string]db.TodoRecoveryState)}
}

func (m *memTodoRecoveryStore) RecordTodoActiveCheckpoint(_ context.Context, row db.TodoRecoveryState) error {
	row.TodoID = strings.TrimSpace(row.TodoID)
	row.MachineID = strings.TrimSpace(row.MachineID)
	row.SessionID = strings.TrimSpace(row.SessionID)
	row.LastActiveBootEpoch = strings.TrimSpace(row.LastActiveBootEpoch)
	if row.TodoID == "" || row.MachineID == "" || row.SessionID == "" || row.LastActiveBootEpoch == "" {
		return errors.New("todo recovery checkpoint requires todo_id, machine_id, session_id and last_active_boot_epoch")
	}
	if row.UpdatedAt.IsZero() {
		row.UpdatedAt = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.rows[row.TodoID]; ok {
		cur.MachineID = row.MachineID
		cur.SessionID = row.SessionID
		cur.LastActiveBootEpoch = row.LastActiveBootEpoch
		cur.UpdatedAt = row.UpdatedAt.UTC()
		m.rows[row.TodoID] = cur
		return nil
	}
	if row.RecoveryAttempts < 0 {
		row.RecoveryAttempts = 0
	}
	row.UpdatedAt = row.UpdatedAt.UTC()
	m.rows[row.TodoID] = row
	return nil
}

func (m *memTodoRecoveryStore) GetTodoRecoveryState(_ context.Context, todoID string) (db.TodoRecoveryState, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[strings.TrimSpace(todoID)]
	return row, ok, nil
}

func (m *memTodoRecoveryStore) ListTodoRecoveryStates(_ context.Context) ([]db.TodoRecoveryState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]db.TodoRecoveryState, 0, len(m.rows))
	for _, r := range m.rows {
		out = append(out, r)
	}
	slices.SortFunc(out, func(a, b db.TodoRecoveryState) int {
		if c := a.UpdatedAt.Compare(b.UpdatedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.TodoID, b.TodoID)
	})
	return out, nil
}

func (m *memTodoRecoveryStore) IncrementTodoRecoveryAttempts(_ context.Context, todoID, newBootEpoch string, recoveredAt time.Time) (db.TodoRecoveryState, error) {
	todoID = strings.TrimSpace(todoID)
	newBootEpoch = strings.TrimSpace(newBootEpoch)
	if todoID == "" || newBootEpoch == "" {
		return db.TodoRecoveryState{}, errors.New("increment todo recovery attempts requires todo_id and new_boot_epoch")
	}
	if recoveredAt.IsZero() {
		recoveredAt = time.Now().UTC()
	}
	at := recoveredAt.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.rows[todoID]
	if !ok {
		return db.TodoRecoveryState{}, db.ErrTodoNotFound
	}
	cur.RecoveryAttempts++
	cur.LastActiveBootEpoch = newBootEpoch
	cur.LastRecoveredAt = &at
	cur.UpdatedAt = at
	m.rows[todoID] = cur
	return cur, nil
}

func (m *memTodoRecoveryStore) ResetTodoRecoveryState(_ context.Context, todoID string, at time.Time) error {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.rows[strings.TrimSpace(todoID)]; ok {
		cur.RecoveryAttempts = 0
		cur.LastRecoveredAt = nil
		cur.UpdatedAt = at.UTC()
		m.rows[cur.TodoID] = cur
	}
	return nil
}

func (m *memTodoRecoveryStore) DeleteTodoRecoveryState(_ context.Context, todoID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, strings.TrimSpace(todoID))
	return nil
}

// restartRecoveryFallbackRegistry attaches a per-Service in-memory recovery store without
// modifying Service fields and cleans up automatically when Service is garbage-collected.
var restartRecoveryFallbackRegistry = struct {
	mu    sync.Mutex
	bySvc map[weak.Pointer[Service]]*memTodoRecoveryStore
}{
	bySvc: make(map[weak.Pointer[Service]]*memTodoRecoveryStore),
}

func (s *Service) todoRecoveryStore() todoRecoveryStore {
	if s == nil {
		return nil
	}
	if st, ok := s.store().(todoRecoveryStore); ok && st != nil {
		return st
	}
	wp := weak.Make(s)
	restartRecoveryFallbackRegistry.mu.Lock()
	defer restartRecoveryFallbackRegistry.mu.Unlock()
	if mem, ok := restartRecoveryFallbackRegistry.bySvc[wp]; ok {
		return mem
	}
	mem := newMemTodoRecoveryStore()
	restartRecoveryFallbackRegistry.bySvc[wp] = mem
	runtime.AddCleanup(s, func(key weak.Pointer[Service]) {
		restartRecoveryFallbackRegistry.mu.Lock()
		delete(restartRecoveryFallbackRegistry.bySvc, key)
		restartRecoveryFallbackRegistry.mu.Unlock()
	}, wp)
	return mem
}

// RecordSupervisedTaskActive persists an active execution checkpoint for an open supervised task.
// When restart_auto_resume is disabled, it is a no-op. If the task is already completed/cancelled,
// any existing recovery attempt counter is reset.
func (s *Service) RecordSupervisedTaskActive(ctx context.Context, todoID, machineID, sessionID, bootEpoch string) error {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() {
		return nil
	}
	todoID = strings.TrimSpace(todoID)
	machineID = strings.TrimSpace(machineID)
	sessionID = strings.TrimSpace(sessionID)
	bootEpoch = strings.TrimSpace(bootEpoch)
	if todoID == "" || machineID == "" || sessionID == "" || bootEpoch == "" {
		return nil
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return nil
	}
	t, ok, err := s.todo(ctx, todoID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if t.DoneAt != nil || t.CancelledAt != nil || t.Cancelled() {
		return st.ResetTodoRecoveryState(ctx, todoID, s.recoveryNow())
	}
	if !isSupervisedRecoverableTodo(t) {
		return nil
	}
	agent, linked := findActiveLinkedAgent(t, machineID, sessionID)
	if !linked || isManualTodoAgent(agent) {
		return nil
	}
	return st.RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
		TodoID:              todoID,
		MachineID:           machineID,
		SessionID:           sessionID,
		LastActiveBootEpoch: bootEpoch,
		UpdatedAt:           s.recoveryNow(),
	})
}

// ResetSupervisedTaskRecovery resets the recovery attempt counter when a task resumes
// normal progress or completes. Bypassed when restart_auto_resume is off.
func (s *Service) ResetSupervisedTaskRecovery(ctx context.Context, todoID string) error {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() {
		return nil
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return nil
	}
	return st.ResetTodoRecoveryState(ctx, todoID, s.recoveryNow())
}

// ClearTodoRecoveryCheckpoint removes the persisted active checkpoint for todoID when a task
// enters pending_review, parked, needs_user, or is explicitly stopped so a subsequent restart
// cannot falsely wake it.
func (s *Service) ClearTodoRecoveryCheckpoint(ctx context.Context, todoID string) error {
	if s == nil {
		return nil
	}
	todoID = strings.TrimSpace(todoID)
	if todoID == "" {
		return nil
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return nil
	}
	return st.DeleteTodoRecoveryState(ctx, todoID)
}

// ClearSupervisedTaskRecovery removes any active recovery checkpoint tied to (machineID, sessionID)
// when a user or supervisor explicitly interrupts or stops that session.
func (s *Service) ClearSupervisedTaskRecovery(ctx context.Context, machineID, sessionID string) error {
	if s == nil {
		return nil
	}
	machineID = strings.TrimSpace(machineID)
	sessionID = strings.TrimSpace(sessionID)
	if machineID == "" || sessionID == "" {
		return nil
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return nil
	}
	states, err := st.ListTodoRecoveryStates(ctx)
	if err != nil {
		return err
	}
	wantMachine := cmp.Or(s.canonical(machineID), machineID)
	var firstErr error
	for _, rec := range states {
		recMachine := cmp.Or(s.canonical(rec.MachineID), strings.TrimSpace(rec.MachineID))
		if recMachine == wantMachine && strings.TrimSpace(rec.SessionID) == sessionID {
			if err := st.DeleteTodoRecoveryState(ctx, rec.TodoID); err != nil && firstErr == nil {
				firstErr = err
			} else if err == nil {
				s.logf("restart_auto_resume action=cleared todo=%s machine=%s session=%s reason=explicit_stop", rec.TodoID, rec.MachineID, rec.SessionID)
			}
		}
	}
	return firstErr
}

// RunRestartRecoverySweep scans persisted active checkpoints from earlier boot epochs and
// automatically resumes restart-interrupted supervised tasks up to maxRestartRecoveryAttempts
// and the hourly storm cap, escalating cleanly once capped. Bypassed when restart_auto_resume is off.
func (s *Service) RunRestartRecoverySweep(ctx context.Context, currentBootEpoch string, sessions []proto.Session) (restartRecoveryResult, error) {
	return s.runRestartRecoverySweepForMachines(ctx, currentBootEpoch, sessions, nil)
}

func (s *Service) runRestartRecoverySweepForMachines(
	ctx context.Context,
	currentBootEpoch string,
	sessions []proto.Session,
	readyMachines map[string]struct{},
) (restartRecoveryResult, error) {
	return s.runRestartRecoverySweepInternal(ctx, currentBootEpoch, sessions, readyMachines, true)
}

func (s *Service) runNodeRestartRecoveryForMachines(
	ctx context.Context,
	currentBootEpoch string,
	sessions []proto.Session,
	readyMachines map[string]struct{},
) (restartRecoveryResult, error) {
	return s.runRestartRecoverySweepInternal(ctx, currentBootEpoch, sessions, readyMachines, false)
}

func (s *Service) runRestartRecoverySweepInternal(
	ctx context.Context,
	currentBootEpoch string,
	sessions []proto.Session,
	readyMachines map[string]struct{},
	hubRestart bool,
) (restartRecoveryResult, error) {
	if s == nil || !s.settings(ctx).restartAutoResumeOn() {
		return restartRecoveryResult{}, nil
	}
	currentBootEpoch = strings.TrimSpace(currentBootEpoch)
	if currentBootEpoch == "" {
		return restartRecoveryResult{}, nil
	}
	st := s.todoRecoveryStore()
	if st == nil {
		return restartRecoveryResult{}, nil
	}
	states, err := st.ListTodoRecoveryStates(ctx)
	if err != nil {
		return restartRecoveryResult{}, err
	}
	if len(states) == 0 {
		return restartRecoveryResult{}, nil
	}

	sessByKey := make(map[[2]string]proto.Session, len(sessions))
	wantCards := make(map[string]map[string]bool)
	for _, sess := range sessions {
		sessByKey[[2]string{sess.MachineID, sess.SessionID}] = sess
	}
	for _, rec := range states {
		if hubRestart && rec.LastActiveBootEpoch == currentBootEpoch {
			continue
		}
		if !hubRestart && rec.LastActiveBootEpoch != currentBootEpoch {
			continue
		}
		if readyMachines != nil {
			if _, ok := readyMachines[rec.MachineID]; !ok {
				continue
			}
		}
		if wantCards[rec.MachineID] == nil {
			wantCards[rec.MachineID] = make(map[string]bool)
		}
		wantCards[rec.MachineID][rec.SessionID] = true
	}
	pendingCards := s.pendingOf(wantCards)
	asks := s.todoAsks(ctx)
	now := s.recoveryNow()
	prog := s.startupRecoveryProgress()

	var result restartRecoveryResult
	for _, rec := range states {
		if readyMachines != nil {
			if _, ok := readyMachines[rec.MachineID]; !ok {
				continue
			}
		}
		if hubRestart && rec.LastActiveBootEpoch == currentBootEpoch {
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}
		if !hubRestart && rec.LastActiveBootEpoch != currentBootEpoch {
			continue
		}

		// Guard 1: open supervised task in active state (excludes done/cancelled/pending_review/parked/needs_user/user_check/closing/timed_out).
		t, ok, err := s.todo(ctx, rec.TodoID)
		if err != nil {
			return result, err
		}
		if !ok || t.DoneAt != nil || t.CancelledAt != nil || t.Cancelled() || !isSupervisedRecoverableTodo(t) {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=task_not_recoverable",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 2: no pending owner card / needs_user / unanswered interaction.
		if hasPendingOwnerWait(t, asks, pendingCards[[2]string{rec.MachineID, rec.SessionID}]) {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=pending_owner_wait",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 3: active linked non-manual Agent (never touch user-opened manual terminals).
		agent, linked := findActiveLinkedAgent(t, rec.MachineID, rec.SessionID)
		if !linked || isManualTodoAgent(agent) {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=unlinked_or_manual",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 4: node must be online (never fire blanks against an offline node).
		if s.isRecoveryMachineOffline(ctx, rec.MachineID) {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=machine_offline",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 5: inspect listed session.
		sess, found := sessByKey[[2]string{rec.MachineID, rec.SessionID}]
		if !found {
			if !hubRestart || readyMachines == nil || isRestartConcludedTodo(t) {
				result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
				continue
			}
			if err := st.RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
				TodoID:              rec.TodoID,
				MachineID:           rec.MachineID,
				SessionID:           rec.SessionID,
				LastActiveBootEpoch: currentBootEpoch,
				RecoveryAttempts:    rec.RecoveryAttempts,
				LastRecoveredAt:     rec.LastRecoveredAt,
				UpdatedAt:           now,
			}); err != nil {
				return result, err
			}
			s.signal(superviseSignal{
				Todo:    t.ID,
				Kind:    sigRecovered,
				Key:     fmt.Sprintf("restart_recovery_missing:%s@%s", t.ID, currentBootEpoch),
				At:      now,
				Machine: rec.MachineID,
				Session: rec.SessionID,
				Detail: fmt.Sprintf(
					"Pre-restart session %s/%s is no longer active after restart (boot epoch %s -> %s); supervisor review required.",
					rec.MachineID, rec.SessionID, rec.LastActiveBootEpoch, currentBootEpoch,
				),
			})
			s.logf("restart_auto_resume action=escalated_missing todo=%s machine=%s session=%s cycle=%s",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.EscalatedTodoIDs = append(result.EscalatedTodoIDs, rec.TodoID)
			continue
		}
		if sess.MachineID == "" {
			sess.MachineID = rec.MachineID
		}

		// Guard 6: archived sessions must never be woken.
		if s.isSessionArchived(rec.MachineID, rec.SessionID, sess) {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=archived",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 7: session-level pending interaction (permission/question/plan card).
		if sess.State == proto.StateNeedsYou || sess.PendingInteractions > 0 {
			s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=pending_interaction",
				rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		// Guard 8: precise restart-interrupted classification (never wake user stops, working sessions, or concluded tasks).
		interrupted, skipReason := isRestartInterruptedSession(t, sess, hubRestart)
		if !interrupted {
			if hubRestart {
				s.logf("restart_auto_resume action=skipped todo=%s machine=%s session=%s cycle=%s reason=%s",
					rec.TodoID, rec.MachineID, rec.SessionID, currentBootEpoch, skipReason)
			}
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}

		cycleID := currentBootEpoch
		trigger := "hub_restart"
		nodeCycleID := nodeRestartCycleKey(rec.MachineID, rec.SessionID, currentBootEpoch, sess)
		if !hubRestart {
			cycleID = nodeCycleID
			trigger = "node_restart"
			if prog.nodeCycleHandled(cycleID) {
				result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
				continue
			}
		}

		// Guard 9: crash-loop & storm caps (consecutive restart attempts + per-session hourly window).
		sessKey := [2]string{rec.MachineID, rec.SessionID}
		hourlyCount := prog.hourlyCount(sessKey, now)
		if rec.RecoveryAttempts >= maxRestartRecoveryAttempts || hourlyCount >= maxRestartAutoResumesPerHour {
			capReason := "attempt_cap"
			sigKey := fmt.Sprintf("restart_recovery_cap:%s@%s", t.ID, cycleID)
			detail := fmt.Sprintf(
				"Automatic restart recovery reached the %d-attempt cap for session %s/%s across restart cycle %s -> %s; supervisor review required.",
				maxRestartRecoveryAttempts, rec.MachineID, rec.SessionID, rec.LastActiveBootEpoch, cycleID,
			)
			if hourlyCount >= maxRestartAutoResumesPerHour {
				capReason = "hourly_cap"
				sigKey = fmt.Sprintf("restart_recovery_hourly_cap:%s@%s", t.ID, cycleID)
				detail = fmt.Sprintf(
					"Automatic restart recovery reached the hourly storm limit (%d/%d within %s) for session %s/%s (cycle %s); supervisor review required.",
					hourlyCount, maxRestartAutoResumesPerHour, restartAutoResumeWindow, rec.MachineID, rec.SessionID, cycleID,
				)
			}
			if hubRestart {
				if err := st.RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
					TodoID:              rec.TodoID,
					MachineID:           rec.MachineID,
					SessionID:           rec.SessionID,
					LastActiveBootEpoch: currentBootEpoch,
					RecoveryAttempts:    rec.RecoveryAttempts,
					LastRecoveredAt:     rec.LastRecoveredAt,
					UpdatedAt:           now,
				}); err != nil {
					return result, err
				}
			}
			prog.markNodeCycleHandled(nodeCycleID)
			s.signal(superviseSignal{
				Todo:    t.ID,
				Kind:    sigRecovered,
				Key:     sigKey,
				At:      now,
				Machine: rec.MachineID,
				Session: rec.SessionID,
				Detail:  detail,
			})
			s.logf("restart_auto_resume action=escalated_cap todo=%s machine=%s session=%s cycle=%s trigger=%s reason=%s attempts=%d/%d hourly=%d/%d",
				rec.TodoID, rec.MachineID, rec.SessionID, cycleID, trigger, capReason,
				rec.RecoveryAttempts, maxRestartRecoveryAttempts, hourlyCount, maxRestartAutoResumesPerHour)
			result.EscalatedTodoIDs = append(result.EscalatedTodoIDs, rec.TodoID)
			continue
		}

		// Under cap -> resume the exact checkpointed session and persist attempt increment.
		prompt := formatRestartRecoveryPrompt(rec.RecoveryAttempts+1, maxRestartRecoveryAttempts)
		if err := s.resumeRestartInterruptedAgent(ctx, t, sess, prompt); err != nil {
			s.logf("restart_auto_resume action=resume_failed todo=%s machine=%s session=%s cycle=%s trigger=%s err=%v",
				rec.TodoID, rec.MachineID, rec.SessionID, cycleID, trigger, err)
			result.SkippedTodoIDs = append(result.SkippedTodoIDs, rec.TodoID)
			continue
		}
		if _, err := st.IncrementTodoRecoveryAttempts(ctx, rec.TodoID, currentBootEpoch, now); err != nil {
			return result, err
		}
		prog.markNodeCycleHandled(nodeCycleID)
		newHourly := prog.recordHourlyResume(sessKey, now)
		s.logf("restart_auto_resume action=resumed todo=%s machine=%s session=%s cycle=%s trigger=%s attempts=%d/%d hourly=%d/%d",
			rec.TodoID, rec.MachineID, rec.SessionID, cycleID, trigger,
			rec.RecoveryAttempts+1, maxRestartRecoveryAttempts, newHourly, maxRestartAutoResumesPerHour)
		result.RecoveredTodoIDs = append(result.RecoveredTodoIDs, rec.TodoID)
	}
	return result, nil
}

// resumeRestartInterruptedAgent wakes the exact checkpointed session sess:
//   - stopped/StatusInterrupted sessions use the guarded resumeAndSend path (preserving launcher,
//     cwd, model, permission mode, and compaction when needed);
//   - live idle/done sessions receive a direct targeted session.send with completion guards.
func (s *Service) resumeRestartInterruptedAgent(ctx context.Context, t Todo, sess proto.Session, prompt string) error {
	if stoppedAgent(sess) {
		if sess.Capabilities != nil && sess.Capabilities.StopCause.UserStopped() {
			return errors.New("refusing to auto-resume user-stopped session")
		}
		am, ok := s.device(ctx, sess.MachineID)
		if !ok {
			if len(s.devices(ctx)) > 0 {
				return errors.New("its machine is offline")
			}
			am = Device{ID: sess.MachineID, Name: sess.MachineID, Online: true, Reachable: true}
		} else if !am.Online && !am.Reachable {
			return errors.New("its machine is offline")
		}
		_, err := s.resumeAndSend(ctx, t.Origin, am, sess, map[string]any{"text": prompt},
			"automatic resume after service restart", prompt, "", nil)
		return err
	}
	cur, ok := s.todoNow(t.ID)
	if !ok {
		return db.ErrTodoNotFound
	}
	if cur.DoneAt != nil || cur.CancelledAt != nil || cur.Cancelled() {
		return db.ErrTodoCompleted
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	if err := s.call(sctx, sess.MachineID, DeviceSessionSend, sendParams(sess.SessionID, prompt, false), nil); err != nil {
		return err
	}
	if _, err := s.appendFeed(sctx, t.Origin, feedRouted, t.ID, map[string]string{
		"text":       prompt,
		"from":       routedFromAssistant,
		"machine_id": sess.MachineID,
		"session_id": sess.SessionID,
	}); err != nil {
		s.logf("task %s: restart recovery feed: %v", t.ID, err)
	}
	return nil
}

func (s *Service) isSessionArchived(machineID, sessionID string, sess proto.Session) bool {
	if sess.Archived {
		return true
	}
	if s == nil {
		return false
	}
	if s.isArchived(sessionID) {
		return true
	}
	if records := s.agentArchives.snapshot.Load(); records != nil {
		if _, ok := archiveRowOf(machineID, sessionID, *records); ok {
			return true
		}
	}
	return false
}

func nodeRestartCycleKey(machineID, sessionID, bootEpoch string, sess proto.Session) string {
	if !sess.UpdatedAt.IsZero() {
		return fmt.Sprintf("node:%s/%s@%s", machineID, sessionID, sess.UpdatedAt.UTC().Format(time.RFC3339Nano))
	}
	return fmt.Sprintf("node:%s/%s@boot:%s", machineID, sessionID, bootEpoch)
}

func isSupervisedRecoverableTodo(t Todo) bool {
	if t.Supervision == nil || strings.TrimSpace(t.Origin) == "" {
		return false
	}
	if t.DoneAt != nil || t.CancelledAt != nil || t.Cancelled() {
		return false
	}
	if t.ReopenedAt == nil && (t.Supervision.State == reviewAccepted || t.Supervision.State == reviewCancelled) {
		return false
	}
	switch t.Supervision.state(t) {
	case "", reviewRework:
		return true
	default:
		// Excludes reviewPending, reviewAccepted, reviewCancelled, reviewParked,
		// reviewNeedsUser, reviewUserCheck, reviewClosing, reviewTimedOut.
		return false
	}
}

func hasPendingOwnerWait(t Todo, asks map[string]todoAsk, cards []proto.Interaction) bool {
	if t.Supervision != nil {
		if t.Supervision.State == reviewNeedsUser || t.Supervision.Waits != nil {
			return true
		}
	}
	if t.planPending {
		return true
	}
	if t.Check != nil && t.Check.Verdict == verdictNeedsUser {
		return true
	}
	if _, hasAsk := asks[t.ID]; hasAsk {
		return true
	}
	return len(cards) > 0
}

func findActiveLinkedAgent(t Todo, machineID, sessionID string) (TodoAgent, bool) {
	for _, a := range t.Agents {
		if a.ReleasedAt != nil || a.DismissedAt != nil {
			continue
		}
		if a.MachineID == machineID && a.SessionID == sessionID {
			return a, true
		}
	}
	return TodoAgent{}, false
}

func isManualTodoAgent(a TodoAgent) bool {
	return strings.EqualFold(strings.TrimSpace(a.Source), "manual")
}

func isRestartConcludedTodo(t Todo) bool {
	if t.DoneAt != nil || t.CancelledAt != nil || t.Cancelled() {
		return true
	}
	if t.Check != nil && t.Check.Verdict == verdictDone {
		return true
	}
	if t.Supervision != nil && t.Supervision.Progress != nil && t.Supervision.Progress.Kind == "done" {
		return true
	}
	return false
}

func isRestartInterruptedSession(t Todo, sess proto.Session, hubRestart bool) (bool, string) {
	if sess.Capabilities != nil {
		if sess.Capabilities.StopCause.UserStopped() {
			return false, "user_stopped"
		}
		if sess.Capabilities.StopCause == proto.StopTimeout {
			return false, "timeout_stopped"
		}
	}
	if sess.TurnError != "" && (sess.TurnErrorKind == proto.TurnErrorAuthFailed || sess.TurnErrorKind == proto.TurnErrorNotLoggedIn) {
		return false, "auth_error"
	}
	status := strings.ToLower(strings.TrimSpace(sess.Status))
	if status == proto.StatusWorking || sess.State == proto.StateWorking {
		return false, "already_working"
	}
	if isRestartConcludedTodo(t) {
		return false, "concluded"
	}
	if !hubRestart {
		if status == proto.StatusInterrupted && sess.Capabilities != nil && sess.Capabilities.StopCause == proto.StopRestart {
			return true, ""
		}
		return false, "not_node_restart_interrupted"
	}
	switch status {
	case proto.StatusIdle, proto.StatusDone, proto.StatusInterrupted:
		return true, ""
	case proto.StatusOffline:
		if sess.Capabilities != nil && sess.Capabilities.StopCause == proto.StopRestart {
			return true, ""
		}
		return false, "offline_status"
	default:
		return false, "unsupported_status_" + status
	}
}

func formatRestartRecoveryPrompt(attempt, maxAttempts int) string {
	return fmt.Sprintf(
		"Service restart interrupted your in-flight task (auto-recovery attempt %d/%d). Please verify current workspace state, clean up any stale temporary artifacts if needed, and continue completing the remaining work and verification.",
		attempt, maxAttempts,
	)
}
