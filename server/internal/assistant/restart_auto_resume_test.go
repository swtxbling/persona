package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
)

func setRestartAutoResumeSetting(t *testing.T, s *Service, want bool) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"restart_auto_resume": want})
	if err != nil {
		t.Fatal(err)
	}
	w, _ := permissionSettingsRequest(t, s, "PUT", "/api/v1/assistant", s.managerIdentity(), "full", string(body))
	if w.Code != http.StatusOK {
		t.Fatalf("PUT restart_auto_resume=%v: code=%d body=%s", want, w.Code, w.Body.String())
	}
}

func TestRestartAutoResumeStandaloneWithoutTodosV2AndDefaultOff(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()

	if s.settings(ctx).todosV2On() {
		t.Fatal("expected todos_v2 default to be false")
	}
	if s.settings(ctx).restartAutoResumeOn() {
		t.Fatal("expected restart_auto_resume default to be false on fresh install")
	}

	// Enable restart_auto_resume standalone (todos_v2 stays false).
	setRestartAutoResumeSetting(t, s, true)
	if !s.settings(ctx).restartAutoResumeOn() || s.settings(ctx).todosV2On() {
		t.Fatalf("expected standalone restart_auto_resume=true with todos_v2=false")
	}

	resumingNode(f)
	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	// Both a live idle task (no done_when required) and a StatusInterrupted (StopRestart) task must auto-resume.
	idleTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Hub restart idle task", "s-idle-default", "assistant", nil, true)
	interruptedTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Hub restart interrupted task", "s-int-default", "assistant", []string{"Checks pass."}, false)

	f.mu.Lock()
	f.sessions["mac"] = append(f.sessions["mac"], proto.Session{
		MachineID: "mac",
		SessionID: "s-int-default",
		Title:     "Hub restart interrupted task",
		Cwd:       "/tmp/work",
		Agent:     "claude",
		Status:    proto.StatusInterrupted,
		Capabilities: &proto.SessionCapabilities{
			Read:      true,
			Terminal:  true,
			StopCause: proto.StopRestart,
		},
		ReadOnlyReason: "stopped",
		UpdatedAt:      time.Now().UTC(),
	})
	f.mu.Unlock()

	if err := s.RecordSupervisedTaskActive(ctx, idleTask.ID, "mac", "s-idle-default", "boot-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordSupervisedTaskActive(ctx, interruptedTask.ID, "mac", "s-int-default", "boot-1"); err != nil {
		t.Fatal(err)
	}

	s.setBootEpoch("boot-2")
	s.superviseWatch(ctx, time.Now().UTC())

	sent := sentToAgent(f)
	if len(sent) != 1 || !strings.Contains(sent[0], "attempt 1/2") {
		t.Fatalf("expected 1 direct send for live idle task, got %+v", sent)
	}
	starts := startCalls(f)
	if len(starts) != 1 || starts[0]["resume_session_id"] != "s-int-default" {
		t.Fatalf("expected 1 guarded resume start for StatusInterrupted task, got %+v", starts)
	}

	// Repeating in the same boot epoch must be strictly idempotent.
	s.superviseWatch(ctx, time.Now().UTC())
	if len(sentToAgent(f)) != 1 || len(startCalls(f)) != 1 {
		t.Fatalf("repeat sweep in same boot must not double-resume: sent=%d starts=%d", len(sentToAgent(f)), len(startCalls(f)))
	}
}

func TestRestartAutoResumeNodeOnlyRestartAndIdempotency(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	resumingNode(f)
	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	task := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Node restart task", "s-node-1", "assistant", []string{"Done."}, false)
	s.setBootEpoch("boot-same")
	if err := s.RecordSupervisedTaskActive(ctx, task.ID, "mac", "s-node-1", "boot-same"); err != nil {
		t.Fatal(err)
	}

	// Simulate fast node service restart (<10m, hub bootEpoch unchanged): node reports StatusInterrupted + StopRestart.
	restartAt := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	f.mu.Lock()
	f.sessions["mac"] = []proto.Session{{
		MachineID: "mac",
		SessionID: "s-node-1",
		Title:     "Node restart task",
		Cwd:       "/tmp/work",
		Agent:     "claude",
		Status:    proto.StatusInterrupted,
		Capabilities: &proto.SessionCapabilities{
			Read:      true,
			Terminal:  true,
			StopCause: proto.StopRestart,
		},
		ReadOnlyReason: "stopped",
		UpdatedAt:      restartAt,
	}}
	f.mu.Unlock()

	// NodeConnected triggers prompt recovery even without waiting for superviseWatch or a 10m outage.
	s.nodeConnectedAt(ctx, "mac", restartAt)

	starts := startCalls(f)
	if len(starts) != 1 || starts[0]["resume_session_id"] != "s-node-1" {
		t.Fatalf("expected 1 resume on fast node restart, got %+v", starts)
	}

	// Subsequent superviseWatch or reconnect for the same node restart marker must not resume again.
	s.superviseWatch(ctx, restartAt.Add(time.Minute))
	s.nodeConnectedAt(ctx, "mac", restartAt.Add(2*time.Minute))
	if len(startCalls(f)) != 1 {
		t.Fatalf("expected idempotent single resume per node restart cycle, got %d", len(startCalls(f)))
	}
}

func TestRestartAutoResumeSixNegativeGuardsNeverFalseWake(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	resumingNode(f)
	f.mu.Lock()
	f.devices = []Device{
		{ID: "mac", Name: "Mac", Online: true, Reachable: true},
		{ID: "offline-box", Name: "Offline Box", Online: false, Reachable: false},
	}
	f.mu.Unlock()

	now := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	s.setRestartRecoveryClock(func() time.Time { return now })

	// 1a. User/supervisor explicit StopCause (StopUser, StopExit, StopTimeout).
	userStopTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "User stopped", "s-user-stop", "assistant", []string{"Done."}, false)
	exitStopTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "User exited", "s-exit-stop", "assistant", []string{"Done."}, false)
	timeoutStopTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Timeout stopped", "s-timeout-stop", "assistant", []string{"Done."}, false)

	// 1b. Explicit agent_interrupt clears checkpoint so subsequent restart never wakes it.
	interruptTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Agent interrupt stopped", "s-agent-int", "assistant", []string{"Done."}, true)
	if err := s.RecordSupervisedTaskActive(ctx, interruptTask.ID, "mac", "s-agent-int", "boot-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearSupervisedTaskRecovery(ctx, "mac", "s-agent-int"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.todoRecoveryStore().GetTodoRecoveryState(ctx, interruptTask.ID); err != nil || found {
		t.Fatalf("explicit stop must delete recovery checkpoint: found=%t err=%v", found, err)
	}

	// 2. Normally completed awaiting acceptance (pending_review).
	pendingReviewTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Pending review", "s-pending-rev", "assistant", []string{"Done."}, true)
	if _, _, err := s.updateSupervision(ctx, pendingReviewTask.ID, func(v *Supervision) bool {
		v.State = reviewPending
		return true
	}); err != nil {
		t.Fatal(err)
	}

	// 3. Done / cancelled / parked / needs_user tasks.
	doneTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Done task", "s-done", "assistant", []string{"Done."}, true)
	if _, err := s.editTodo(ctx, doneTask.ID, db.TodoEdit{Done: new(true)}); err != nil {
		t.Fatal(err)
	}
	cancelledTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Cancelled task", "s-cancelled", "assistant", []string{"Done."}, true)
	if _, _, err := s.updateSupervision(ctx, cancelledTask.ID, func(v *Supervision) bool {
		v.State = reviewCancelled
		return true
	}); err != nil {
		t.Fatal(err)
	}
	parkedTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Parked task", "s-parked", "assistant", []string{"Done."}, true)
	if _, _, err := s.updateSupervision(ctx, parkedTask.ID, func(v *Supervision) bool {
		v.State = reviewParked
		v.Reviews = append(v.Reviews, TaskReview{At: now, Verdict: reviewParked, Until: now.Add(time.Hour), WaitingOn: "external"})
		return true
	}); err != nil {
		t.Fatal(err)
	}
	needsUserTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Needs user task", "s-needs-user", "assistant", []string{"Done."}, true)
	if _, _, err := s.updateSupervision(ctx, needsUserTask.ID, func(v *Supervision) bool {
		v.State = reviewNeedsUser
		return true
	}); err != nil {
		t.Fatal(err)
	}

	// 4. Waiting for owner or supervisor reply to an interaction (StateNeedsYou / PendingInteractions > 0).
	interactionTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Interaction wait", "s-interaction", "assistant", []string{"Done."}, false)

	// 5. Archived session (sess.Archived = true and conversation archived).
	archivedTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Archived session", "s-archived", "assistant", []string{"Done."}, false)

	// 6. Offline node.
	offlineTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "offline-box", "Offline node task", "s-offline", "assistant", []string{"Done."}, true)

	// Inject checkpoints directly for all negative cases to prove sweep guards block every single one.
	for _, tc := range []struct {
		todoID, machine, sid string
	}{
		{userStopTask.ID, "mac", "s-user-stop"},
		{exitStopTask.ID, "mac", "s-exit-stop"},
		{timeoutStopTask.ID, "mac", "s-timeout-stop"},
		{pendingReviewTask.ID, "mac", "s-pending-rev"},
		{doneTask.ID, "mac", "s-done"},
		{cancelledTask.ID, "mac", "s-cancelled"},
		{parkedTask.ID, "mac", "s-parked"},
		{needsUserTask.ID, "mac", "s-needs-user"},
		{interactionTask.ID, "mac", "s-interaction"},
		{archivedTask.ID, "mac", "s-archived"},
		{offlineTask.ID, "offline-box", "s-offline"},
	} {
		if err := s.todoRecoveryStore().RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
			TodoID:              tc.todoID,
			MachineID:           tc.machine,
			SessionID:           tc.sid,
			LastActiveBootEpoch: "boot-1",
			UpdatedAt:           now,
		}); err != nil {
			t.Fatalf("inject checkpoint %s: %v", tc.todoID, err)
		}
	}

	sessions := []proto.Session{
		{MachineID: "mac", SessionID: "s-user-stop", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopUser}},
		{MachineID: "mac", SessionID: "s-exit-stop", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopExit}},
		{MachineID: "mac", SessionID: "s-timeout-stop", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopTimeout}},
		{MachineID: "mac", SessionID: "s-agent-int", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-pending-rev", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-done", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-cancelled", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-parked", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-needs-user", Status: proto.StatusIdle},
		{MachineID: "mac", SessionID: "s-interaction", Status: proto.StatusIdle, State: proto.StateNeedsYou, PendingInteractions: 1},
		{MachineID: "mac", SessionID: "s-archived", Status: proto.StatusIdle, Archived: true},
		{MachineID: "offline-box", SessionID: "s-offline", Status: proto.StatusIdle},
	}

	res, err := s.RunRestartRecoverySweep(ctx, "boot-2", sessions)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RecoveredTodoIDs) != 0 || len(res.EscalatedTodoIDs) != 0 {
		t.Fatalf("none of the 6 negative classes may be woken or escalated: res=%+v", res)
	}
	if len(sentToAgent(f)) != 0 || len(startCalls(f)) != 0 {
		t.Fatalf("expected 0 sends and 0 resume starts across all 6 negative classes, got sent=%+v starts=%+v", sentToAgent(f), startCalls(f))
	}

	// Verify offline-box task recovers once the node comes back online.
	f.mu.Lock()
	f.devices[1].Online = true
	f.devices[1].Reachable = true
	f.mu.Unlock()

	resOnline, err := s.RunRestartRecoverySweep(ctx, "boot-2", []proto.Session{
		{MachineID: "offline-box", SessionID: "s-offline", Status: proto.StatusIdle},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resOnline.RecoveredTodoIDs) != 1 || resOnline.RecoveredTodoIDs[0] != offlineTask.ID {
		t.Fatalf("expected offline task to recover once node is online, got %+v", resOnline)
	}
}

func TestRestartAutoResumeHourlyStormCapAndWindowReset(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	origWindow := restartAutoResumeWindow
	origMaxPerHour := maxRestartAutoResumesPerHour
	t.Cleanup(func() {
		restartAutoResumeWindow = origWindow
		maxRestartAutoResumesPerHour = origMaxPerHour
	})
	restartAutoResumeWindow = time.Hour
	maxRestartAutoResumesPerHour = 3

	now := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	s.setRestartRecoveryClock(func() time.Time { return now })

	task := setupSupervisedRecoveryTask(t, s, f, "Stormy task", "s-storm", "assistant", []string{"Done."})
	if err := s.RecordSupervisedTaskActive(ctx, task.ID, "mac", "s-storm", "boot-0"); err != nil {
		t.Fatal(err)
	}
	idle := []proto.Session{{MachineID: "mac", SessionID: "s-storm", Status: proto.StatusIdle}}

	// Simulate 3 restarts within 1 hour, resetting consecutive attempts between each (e.g. brief progress).
	for i, epoch := range []string{"boot-1", "boot-2", "boot-3"} {
		now = now.Add(10 * time.Minute)
		res, err := s.RunRestartRecoverySweep(ctx, epoch, idle)
		if err != nil || len(res.RecoveredTodoIDs) != 1 {
			t.Fatalf("attempt %d (%s) should recover: res=%+v err=%v", i+1, epoch, res, err)
		}
		if err := s.ResetSupervisedTaskRecovery(ctx, task.ID); err != nil {
			t.Fatal(err)
		}
	}

	// 4th restart within the same 1-hour window must hit the hourly storm cap and escalate instead of resuming.
	now = now.Add(10 * time.Minute)
	resCap, err := s.RunRestartRecoverySweep(ctx, "boot-4", idle)
	if err != nil {
		t.Fatal(err)
	}
	if len(resCap.RecoveredTodoIDs) != 0 || len(resCap.EscalatedTodoIDs) != 1 || resCap.EscalatedTodoIDs[0] != task.ID {
		t.Fatalf("expected hourly storm cap escalation on 4th restart, got %+v", resCap)
	}
	if len(sentToAgent(f)) != 3 {
		t.Fatalf("must not send 4th resume after hourly cap, got %d", len(sentToAgent(f)))
	}
	s.supervise.mu.Lock()
	sig, hasSig := s.supervise.pending[task.ID+"|"+sigRecovered]
	s.supervise.mu.Unlock()
	if !hasSig || !strings.Contains(sig.Key, "restart_recovery_hourly_cap:") {
		t.Fatalf("expected hourly storm cap sigRecovered, got has=%t sig=%+v", hasSig, sig)
	}

	// Advance deterministic clock past the 1-hour window (zero time.Sleep): auto-resume is allowed again.
	now = now.Add(61 * time.Minute)
	resAfterWindow, err := s.RunRestartRecoverySweep(ctx, "boot-5", idle)
	if err != nil {
		t.Fatal(err)
	}
	if len(resAfterWindow.RecoveredTodoIDs) != 1 || resAfterWindow.RecoveredTodoIDs[0] != task.ID {
		t.Fatalf("expected recovery allowed after 1-hour window elapsed, got %+v", resAfterWindow)
	}
}

func TestRestartAutoResumeKillSwitchDisablesRecovery(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()

	// Even when todos_v2 is enabled, an explicit restart_auto_resume=false overrides and disables recovery.
	setRestartRecoveryTodosV2(t, s, true, false)
	setRestartAutoResumeSetting(t, s, false)
	if s.settings(ctx).restartAutoResumeOn() {
		t.Fatal("expected explicit restart_auto_resume=false to override todos_v2=true")
	}

	task := setupSupervisedRecoveryTask(t, s, f, "Disabled switch task", "s-disabled", "assistant", []string{"Done."})
	if err := s.RecordSupervisedTaskActive(ctx, task.ID, "mac", "s-disabled", "boot-1"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := s.todoRecoveryStore().GetTodoRecoveryState(ctx, task.ID); err != nil || found {
		t.Fatalf("restart_auto_resume=false must not persist recovery checkpoints: found=%t err=%v", found, err)
	}

	// Even with a pre-existing checkpoint, sweep is a strict no-op when disabled.
	if err := s.todoRecoveryStore().RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
		TodoID:              task.ID,
		MachineID:           "mac",
		SessionID:           "s-disabled",
		LastActiveBootEpoch: "boot-1",
	}); err != nil {
		t.Fatal(err)
	}
	res, err := s.RunRestartRecoverySweep(ctx, "boot-2", []proto.Session{
		{MachineID: "mac", SessionID: "s-disabled", Status: proto.StatusIdle},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RecoveredTodoIDs) != 0 || len(res.EscalatedTodoIDs) != 0 || len(sentToAgent(f)) != 0 {
		t.Fatalf("restart_auto_resume=false must bypass sweep: res=%+v sent=%+v", res, sentToAgent(f))
	}
}

func TestRestartAutoResumeNormalTurnEndClearsCheckpointBeforeRestart(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	task := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Normal turn end task", "s-normal-end", "assistant", []string{"Done."}, false)
	s.setBootEpoch("boot-1")

	// Tick 1: Agent is working -> checkpoint persisted under boot-1.
	f.mu.Lock()
	f.sessions["mac"] = []proto.Session{{
		MachineID: "mac",
		SessionID: "s-normal-end",
		Status:    proto.StatusWorking,
		State:     proto.StateWorking,
		UpdatedAt: time.Now().UTC(),
	}}
	f.mu.Unlock()
	s.superviseWatch(ctx, time.Now().UTC())
	if _, found, err := s.todoRecoveryStore().GetTodoRecoveryState(ctx, task.ID); err != nil || !found {
		t.Fatalf("expected active checkpoint while working: found=%t err=%v", found, err)
	}

	// Tick 2: Agent ends its turn normally (Idle) before any restart -> checkpoint cleared.
	f.mu.Lock()
	f.sessions["mac"] = []proto.Session{{
		MachineID: "mac",
		SessionID: "s-normal-end",
		Status:    proto.StatusIdle,
		UpdatedAt: time.Now().UTC(),
	}}
	f.mu.Unlock()
	s.superviseWatch(ctx, time.Now().UTC())
	if _, found, err := s.todoRecoveryStore().GetTodoRecoveryState(ctx, task.ID); err != nil || found {
		t.Fatalf("normal turn end must clear same-epoch checkpoint: found=%t err=%v", found, err)
	}

	// Subsequent hub restart (boot-2) must NEVER falsely wake this task.
	s.setBootEpoch("boot-2")
	s.todosV2RecoverySwept.Store(false)
	s.superviseWatch(ctx, time.Now().UTC())
	if len(sentToAgent(f)) != 0 || len(startCalls(f)) != 0 {
		t.Fatalf("hub restart must not wake task that ended normally before restart: sent=%+v starts=%+v", sentToAgent(f), startCalls(f))
	}
}

func TestRestartAutoResumeRejectsNonRestartStopCausesAndUncompactableFullContext(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	resumingNode(f)
	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	cases := []struct {
		name string
		sess proto.Session
	}{
		{
			name: "stop_idle",
			sess: proto.Session{MachineID: "mac", SessionID: "s-stop-idle", Status: proto.StatusOffline, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopIdle}},
		},
		{
			name: "stop_usage_limit",
			sess: proto.Session{MachineID: "mac", SessionID: "s-stop-usage", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopUsageLimit}},
		},
		{
			name: "stop_compact_failed",
			sess: proto.Session{MachineID: "mac", SessionID: "s-stop-compact", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopCompactFailed}},
		},
		{
			name: "stop_resume_failed",
			sess: proto.Session{MachineID: "mac", SessionID: "s-stop-resume", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopResumeFailed}},
		},
		{
			name: "stop_unknown_stopped",
			sess: proto.Session{MachineID: "mac", SessionID: "s-stop-unknown", Status: proto.StatusInterrupted, Capabilities: &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopUnknown}},
		},
		{
			name: "nil_capabilities_stopped",
			sess: proto.Session{MachineID: "mac", SessionID: "s-nil-caps", Status: proto.StatusInterrupted},
		},
		{
			name: "live_runtime_interrupted_stop_unknown",
			sess: proto.Session{
				MachineID:    "mac",
				SessionID:    "s-t3-cancelled",
				SourceKind:   "t3code",
				Status:       proto.StatusInterrupted,
				Capabilities: &proto.SessionCapabilities{Read: true, Send: true, StopCause: proto.StopUnknown},
			},
		},
		{
			name: "live_runtime_interrupted_nil_caps",
			sess: proto.Session{
				MachineID:  "mac",
				SessionID:  "s-runtime-int-nil",
				SourceKind: "opencode",
				Status:     proto.StatusInterrupted,
			},
		},
		{
			name: "context_full_uncompactable",
			sess: proto.Session{
				MachineID:     "mac",
				SessionID:     "s-full-uncompactable",
				Agent:         "claude",
				SourceKind:    proto.SourceClaudeBg,
				Status:        proto.StatusInterrupted,
				ContextTokens: 195000,
				ContextWindow: 200000,
				Capabilities:  &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopRestart},
			},
		},
	}

	var sessions []proto.Session
	for _, tc := range cases {
		task := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", tc.name, tc.sess.SessionID, "assistant", []string{"Done."}, false)
		if err := s.todoRecoveryStore().RecordTodoActiveCheckpoint(ctx, db.TodoRecoveryState{
			TodoID:              task.ID,
			MachineID:           "mac",
			SessionID:           tc.sess.SessionID,
			LastActiveBootEpoch: "boot-1",
		}); err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, tc.sess)
	}

	res, err := s.RunRestartRecoverySweep(ctx, "boot-2", sessions)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RecoveredTodoIDs) != 0 || len(res.EscalatedTodoIDs) != 0 || len(sentToAgent(f)) != 0 || len(startCalls(f)) != 0 {
		t.Fatalf("none of non-restart stop causes / uncompactable full contexts may be resumed: res=%+v sent=%+v starts=%+v", res, sentToAgent(f), startCalls(f))
	}
	// Stale old-epoch checkpoints skipped for terminal non-restart reasons (e.g. StopIdle, StopUnknown) must be cleared so they cannot linger across later restarts.
	remaining, err := s.todoRecoveryStore().ListTodoRecoveryStates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range remaining {
		if r.SessionID != "s-full-uncompactable" {
			t.Fatalf("expected stale terminal-skipped checkpoint %s to be deleted, still present: %+v", r.SessionID, r)
		}
	}
}

func TestRestartAutoResumeConcurrentNodeConnectedAndWatchSingleResume(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	f.answerNode(DeviceSessionStart, func(_ string, params json.RawMessage) (any, error) {
		var p map[string]any
		_ = json.Unmarshal(params, &p)
		id, _ := p["resume_session_id"].(string)
		entered <- struct{}{}
		<-release
		return map[string]any{"session": proto.Session{SessionID: id, Agent: "claude", Status: proto.StatusIdle}}, nil
	})
	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	task := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Concurrent node restart", "s-conc-1", "assistant", []string{"Done."}, false)
	s.setBootEpoch("boot-conc")
	if err := s.RecordSupervisedTaskActive(ctx, task.ID, "mac", "s-conc-1", "boot-conc"); err != nil {
		t.Fatal(err)
	}
	restartAt := time.Date(2026, 11, 26, 11, 0, 0, 0, time.UTC)
	f.mu.Lock()
	f.sessions["mac"] = []proto.Session{{
		MachineID:      "mac",
		SessionID:      "s-conc-1",
		Agent:          "claude",
		Status:         proto.StatusInterrupted,
		Capabilities:   &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopRestart},
		ReadOnlyReason: "stopped",
		UpdatedAt:      restartAt,
	}}
	f.mu.Unlock()

	var wg sync.WaitGroup
	startGate := make(chan struct{})
	for i := range 6 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startGate
			if idx%2 == 0 {
				s.onNodeReconnectedForRestartRecovery(ctx, "mac")
			} else {
				s.maybeRunNodeRestartRecovery(ctx, nil)
			}
		}(i)
	}
	close(startGate)
	<-entered
	close(release)
	wg.Wait()

	if starts := startCalls(f); len(starts) != 1 {
		t.Fatalf("concurrent NodeConnected + superviseWatch must resume exactly once, got %d starts: %+v", len(starts), starts)
	}
}

func TestRestartAutoResumeCooldownResetAndNonOfflineFailureNoSpam(t *testing.T) {
	s, f := newQuietServiceOn(t, nil)
	s.superviseTimes = superviseTimings{gather: time.Hour, every: time.Hour, urgent: time.Hour}
	ctx := context.Background()
	setRestartAutoResumeSetting(t, s, true)

	now := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	s.setRestartRecoveryClock(func() time.Time { return now })

	f.mu.Lock()
	f.devices = []Device{{ID: "mac", Name: "Mac", Online: true, Reachable: true}}
	f.mu.Unlock()

	// Part 1: 2 restarts within 1h exhaust cap, then advancing clock past cooldown resets attempts cleanly.
	task := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Cooldown task", "s-cool", "assistant", []string{"Done."}, true)
	if err := s.RecordSupervisedTaskActive(ctx, task.ID, "mac", "s-cool", "boot-0"); err != nil {
		t.Fatal(err)
	}
	idle := []proto.Session{{MachineID: "mac", SessionID: "s-cool", Status: proto.StatusIdle}}
	if res, err := s.RunRestartRecoverySweep(ctx, "boot-1", idle); err != nil || len(res.RecoveredTodoIDs) != 1 {
		t.Fatalf("boot-1 expected recover: res=%+v err=%v", res, err)
	}
	now = now.Add(5 * time.Minute)
	if res, err := s.RunRestartRecoverySweep(ctx, "boot-2", idle); err != nil || len(res.RecoveredTodoIDs) != 1 {
		t.Fatalf("boot-2 expected recover: res=%+v err=%v", res, err)
	}
	now = now.Add(5 * time.Minute)
	if res, err := s.RunRestartRecoverySweep(ctx, "boot-3", idle); err != nil || len(res.EscalatedTodoIDs) != 1 {
		t.Fatalf("boot-3 expected cap escalation: res=%+v err=%v", res, err)
	}
	// Advance 2 hours (> 1h cooldown): genuine deploy later resets persisted attempts and recovers once more.
	now = now.Add(2 * time.Hour)
	if res, err := s.RunRestartRecoverySweep(ctx, "boot-4", idle); err != nil || len(res.RecoveredTodoIDs) != 1 {
		t.Fatalf("boot-4 after cooldown expected recover: res=%+v err=%v", res, err)
	}

	// Part 2: Permanent non-offline resume failure escalates once and does not retry every tick.
	failCalls := 0
	f.answerNode(DeviceSessionStart, func(_ string, _ json.RawMessage) (any, error) {
		failCalls++
		return nil, errors.New("runtime rejected resume")
	})
	failTask := setupSupervisedRecoveryTaskOnMachine(t, s, f, "mac", "Failing resume task", "s-fail-resume", "assistant", []string{"Done."}, false)
	if err := s.RecordSupervisedTaskActive(ctx, failTask.ID, "mac", "s-fail-resume", "boot-4"); err != nil {
		t.Fatal(err)
	}
	interrupted := []proto.Session{{
		MachineID:      "mac",
		SessionID:      "s-fail-resume",
		Agent:          "claude",
		Status:         proto.StatusInterrupted,
		Capabilities:   &proto.SessionCapabilities{Read: true, Terminal: true, StopCause: proto.StopRestart},
		ReadOnlyReason: "stopped",
		UpdatedAt:      now,
	}}
	resFail1, err := s.RunRestartRecoverySweep(ctx, "boot-5", interrupted)
	if err != nil || len(resFail1.EscalatedTodoIDs) != 1 || failCalls != 1 {
		t.Fatalf("expected 1 failure escalation on first sweep: res=%+v calls=%d err=%v", resFail1, failCalls, err)
	}
	resFail2, err := s.RunRestartRecoverySweep(ctx, "boot-5", interrupted)
	if err != nil || len(resFail2.EscalatedTodoIDs) != 0 || failCalls != 1 {
		t.Fatalf("repeat sweep in same cycle must not retry permanently failed resume: res=%+v calls=%d err=%v", resFail2, failCalls, err)
	}
}
