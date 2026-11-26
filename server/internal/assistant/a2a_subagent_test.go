package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/assistantwire"
	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/devicewire"
	"github.com/nwverse/persona/server/internal/proto"
)

// memA2AStore embeds memStore and adds an in-memory a2aStore implementation so A2A
// subagent launch, visibility decoupling, and restart-persistence tests always execute
// under `go test -race` even when PERSONA_TEST_DATABASE_URL is not configured.
type memA2AStore struct {
	memStore
	mu              sync.Mutex
	rows            map[string]db.A2ARow
	launchQueries   int
	launchTargets   int
	launchTargetHit map[[2]string]int
}

func newMemA2AStore() *memA2AStore {
	return &memA2AStore{rows: map[string]db.A2ARow{}}
}

func (m *memA2AStore) A2ACreate(_ context.Context, r db.A2ARow) (*db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, old := range m.rows {
		if old.Owner == r.Owner && old.Request == r.Request {
			cp := old
			return &cp, nil
		}
	}
	if r.Created.IsZero() {
		r.Created = time.Now().UTC()
	}
	if r.State == a2aSubmitted {
		for _, old := range m.rows {
			if old.TargetMachine == r.TargetMachine && old.TargetSession == r.TargetSession && !a2aTerminal(old.State) {
				r.State = a2aQueued
				break
			}
		}
	}
	r.Revision = 1
	m.rows[r.ID] = r
	cp := r
	return &cp, nil
}

func (m *memA2AStore) A2ARequest(_ context.Context, owner, request string) (*db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.Owner == owner && r.Request == request {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *memA2AStore) A2AGet(_ context.Context, id string) (*db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil, nil
	}
	cp := r
	return &cp, nil
}

func (m *memA2AStore) A2AList(_ context.Context, owner, machine, session, contextID, state, _ string, participant bool, _ *time.Time, limit int) ([]db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []db.A2ARow
	for _, r := range m.rows {
		ownerMatch := r.Owner == owner && (participant || machine == "" || (r.TargetMachine == machine && r.TargetSession == session))
		targetMatch := participant && r.TargetMachine == machine && r.TargetSession == session
		if !ownerMatch && !targetMatch {
			continue
		}
		if contextID != "" && r.Context != contextID {
			continue
		}
		if state != "" && r.State != state && !(state == a2aSubmitted && r.State == a2aQueued) {
			continue
		}
		out = append(out, r)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (m *memA2AStore) A2ACount(ctx context.Context, owner, machine, session, contextID, state string, after *time.Time) (int, error) {
	rows, err := m.A2AList(ctx, owner, machine, session, contextID, state, "", false, after, 0)
	return len(rows), err
}

func (m *memA2AStore) A2AUpdate(_ context.Context, r db.A2ARow, _ time.Time, _ *time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.rows[r.ID]
	if !ok || old.Revision != r.Revision {
		return false, nil
	}
	r.Revision++
	m.rows[r.ID] = r
	return true, nil
}

func (m *memA2AStore) A2AClaim(_ context.Context, limit int) ([]db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []db.A2ARow
	for _, r := range m.rows {
		if !a2aTerminal(r.State) && r.State != a2aQueued {
			out = append(out, r)
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *memA2AStore) A2AReady(_ context.Context, _, _ string) error { return nil }

func (m *memA2AStore) A2ADispatches(_ context.Context, owner, machine, session string, since time.Time) ([]db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []db.A2ARow
	for _, r := range m.rows {
		var body a2aBody
		if json.Unmarshal(r.Body, &body) != nil || body.Launch == nil {
			continue
		}
		isTarget := r.TargetMachine == machine && r.TargetSession == session
		if r.Owner != owner && !isTarget {
			continue
		}
		if isTarget || !r.Created.Before(since) || !a2aTerminal(r.State) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memA2AStore) A2ALaunchesForTargets(_ context.Context, machine string, sessions []string) ([]db.A2ARow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.launchQueries++
	m.launchTargets += len(sessions)
	if m.launchTargetHit == nil {
		m.launchTargetHit = map[[2]string]int{}
	}
	want := make(map[string]bool, len(sessions))
	for _, sid := range sessions {
		want[sid] = true
		m.launchTargetHit[[2]string{machine, sid}]++
	}
	var out []db.A2ARow
	for _, r := range m.rows {
		if r.TargetMachine != machine || !want[r.TargetSession] || r.SourceSession == "" {
			continue
		}
		var body a2aBody
		if json.Unmarshal(r.Body, &body) != nil || body.Launch == nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func memA2AFixture(t *testing.T) (*Service, *a2aTestHub, *memA2AStore, a2aCaller, a2aRef) {
	t.Helper()
	st := newMemA2AStore()
	f := newFakeHub()
	h := &a2aTestHub{fakeHub: f}
	f.hello.Agents.A2A = assistantwire.A2AConfig{} // default scope: Machines == nil, Launch == nil
	f.hello.Agents.Dispatch.Enabled = nil          // dispatch switch off by default
	from, peer := a2aRef{"mac", "caller-0001"}, a2aRef{"box", "runtime.peer-0001"}
	f.sessions[from.Machine] = []proto.Session{{SessionID: from.Session, Status: proto.StatusWorking, Agent: "claude", PermissionMode: "acceptEdits"}}
	f.sessions[peer.Machine] = []proto.Session{{SessionID: peer.Session, Status: proto.StatusIdle, Agent: "pi",
		SourceKind: "runtime", Capabilities: &proto.SessionCapabilities{Send: true, Read: true}}}
	s := New(Options{Hub: h, Store: func() Store { return st }, Logf: testLogf(t)})
	return s, h, st, a2aSessionCaller(from), peer
}

func processMemA2A(t *testing.T, s *Service, st *memA2AStore, cfg assistantwire.A2AConfig, id string) *a2aTask {
	t.Helper()
	ctx := t.Context()
	task, err := decodeA2A(st.A2AGet(ctx, id))
	if err != nil || task == nil {
		t.Fatalf("get task %s: %v %v", id, task, err)
	}
	if err := s.a2aProcess(ctx, st, cfg, task); err != nil {
		t.Fatal(err)
	}
	task, err = decodeA2A(st.A2AGet(ctx, id))
	if err != nil || task == nil {
		t.Fatalf("get processed task %s: %v %v", id, task, err)
	}
	return task
}

// Verifies default-enabled cross-machine & same-machine cross-harness A2A subagent launches,
// config opt-outs, permission_mode capping, durable subagent provenance across restarts,
// peer preservation, and a2aDiscoverable vs a2aTaskEndpointAllowed decoupling without Postgres.
func TestA2ADefaultSubagentFlowWithoutPostgres(t *testing.T) {
	s, h, st, parent, peer := memA2AFixture(t)
	ctx := t.Context()
	h.fakeModel(t)
	h.startReply = func(args map[string]any, row *proto.Session) *proto.StartInstead {
		row.SessionID = args["session_id"].(string)
		return nil
	}

	// 1. Default cross-machine launch works without agents.dispatch.enabled or explicit machines list.
	rawCross, _ := json.Marshal(map[string]any{
		"machine_id": "box", "cwd": "/code/app", "launcher": "codex",
		"message_id": "m-cross-1", "text": "Run Linux checks.",
	})
	resCross := s.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawCross, false)
	if resCross.IsError {
		t.Fatalf("default cross-machine launch failed: %s", resultText(resCross))
	}
	var crossView a2aTaskView
	if err := json.Unmarshal([]byte(resultText(resCross)), &crossView); err != nil {
		t.Fatal(err)
	}
	cfg := s.a2aConfig(ctx)
	processMemA2A(t, s, st, cfg, crossView.ID)
	var tk *a2aTask
	waitFor(t, "cross launch finished", func() bool {
		var err error
		tk, err = decodeA2A(st.A2AGet(ctx, crossView.ID))
		return err == nil && tk != nil && tk.Launch != nil && !tk.Launch.Pending
	})
	if !tk.Launch.Subagent || len(h.starts) != 1 || h.starts[0]["permission_mode"] != "plan" {
		t.Fatalf("cross launch = %+v, starts = %+v", tk.Launch, h.starts)
	}

	// 2. Default same-machine cross-harness launch (mac Claude -> mac Codex) with live bypass attestation
	// allows acceptEdits; cached session mode alone without live attestation must fail closed.
	rawSame, _ := json.Marshal(map[string]any{
		"machine_id": parent.Ref.Machine, "cwd": "/code/app", "launcher": "codex",
		"permission_mode": "acceptEdits",
		"message_id":      "m-same-1", "text": "Review patch with Codex.",
	})
	if unattested := s.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawSame, false); !unattested.IsError {
		t.Fatalf("acceptEdits without live source-node attestation must fail closed: %s", resultText(unattested))
	}
	bypassCtx := devicewire.WithSourcePermission(ctx, testSourcePermission(parent.Ref.Session, "a2a_send", rawSame, "bypass"))
	resSame := s.mcpCall(bypassCtx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawSame, false)
	if resSame.IsError {
		t.Fatalf("same-machine cross-harness A2A launch with bypass attestation failed: %s", resultText(resSame))
	}
	var sameView a2aTaskView
	if err := json.Unmarshal([]byte(resultText(resSame)), &sameView); err != nil {
		t.Fatal(err)
	}
	processMemA2A(t, s, st, cfg, sameView.ID)
	waitFor(t, "same-machine launch finished", func() bool {
		t2, err := decodeA2A(st.A2AGet(ctx, sameView.ID))
		return err == nil && t2 != nil && t2.Launch != nil && !t2.Launch.Pending
	})
	if len(h.starts) != 2 || h.starts[1]["permission_mode"] != "acceptEdits" {
		t.Fatalf("same-machine launch permission_mode not honored: %+v", h.starts)
	}

	// 3. Permission policy: every proto.PermissionModes member is explicitly ranked; "auto" is never
	// treated as "plan", unknown modes fail closed, and prompting attestation caps at "default".
	for _, m := range proto.PermissionModes {
		rank, ok := a2aPermissionRank(m)
		if !ok {
			t.Fatalf("proto.PermissionModes entry %q missing from a2aPermissionRank", m)
		}
		if (m == "plan") != (rank == 0) {
			t.Fatalf("mode %q rank=%d, only plan may have rank 0", m, rank)
		}
	}
	if _, ok := a2aPermissionRank("unknown_mode"); ok {
		t.Fatal("unknown permission mode must fail closed")
	}
	// Prompting attestation allows "default" but rejects "acceptEdits", "auto", and "bypassPermissions".
	for _, mode := range []string{"acceptEdits", "auto", "bypassPermissions", "dontAsk"} {
		rawMode, _ := json.Marshal(map[string]any{
			"machine_id": "box", "cwd": "/code/app", "permission_mode": mode,
			"message_id": "m-mode-" + mode, "text": "Check.",
		})
		promptCtx := devicewire.WithSourcePermission(ctx, testSourcePermission(parent.Ref.Session, "a2a_send", rawMode, "prompting"))
		if r := s.mcpCall(promptCtx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawMode, false); !r.IsError {
			t.Fatalf("prompting attestation allowed %q: %s", mode, resultText(r))
		}
		// Even with cached bypassPermissions on the session row, missing live attestation rejects "auto" and above.
		h.sessions[parent.Ref.Machine][0].PermissionMode = "bypassPermissions"
		if r := s.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawMode, false); !r.IsError {
			t.Fatalf("cached bypass session without live attestation allowed %q: %s", mode, resultText(r))
		}
	}
	// Idempotent retry of m-same-1 MUST succeed even without live bypass attestation AND even if Launch=false!
	offToggle := false
	h.hello.Agents.A2A = assistantwire.A2AConfig{Launch: &offToggle}
	retrySame := s.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawSame, false)
	if retrySame.IsError {
		t.Fatalf("idempotent retry of m-same-1 was blocked by changed permission/launch policy: %s", resultText(retrySame))
	}
	var retryView a2aTaskView
	if err := json.Unmarshal([]byte(resultText(retrySame)), &retryView); err != nil || retryView.ID != sameView.ID {
		t.Fatalf("retry returned wrong task: %+v vs %+v (%v)", retryView, sameView, err)
	}
	h.hello.Agents.A2A = assistantwire.A2AConfig{}

	// 4. Ordinary A2A message to an existing independent peer NEVER marks it as a subagent.
	rawPeer, _ := json.Marshal(map[string]any{
		"machine_id": peer.Machine, "session_id": peer.Session,
		"message_id": "m-peer-1", "text": "Please review.",
	})
	if r := s.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawPeer, false); r.IsError {
		t.Fatalf("peer send failed: %s", resultText(r))
	}

	// 5. Simulated restart: even a 90-day-old A2A subagent still listed recovers full provenance
	// via A2ALaunchesForTargets (no 30-day or 2000-row truncation).
	st.mu.Lock()
	oldRow := st.rows[tk.ID]
	oldRow.Created = time.Now().Add(-90 * 24 * time.Hour).UTC()
	st.rows[tk.ID] = oldRow
	st.mu.Unlock()
	restarted := New(Options{Hub: h, Store: func() Store { return st }, Logf: testLogf(t)})
	subRef := tk.target()
	boxRows := []proto.Session{
		{MachineID: peer.Machine, SessionID: peer.Session, Status: proto.StatusIdle, Agent: "pi",
			SourceKind: "runtime", Capabilities: &proto.SessionCapabilities{Send: true, Read: true}},
		{MachineID: subRef.Machine, SessionID: subRef.Session, Status: proto.StatusIdle, Agent: "codex",
			Capabilities: &proto.SessionCapabilities{Send: true, Read: true}},
	}
	restarted.decorateSubagents(ctx, "box", boxRows)
	if boxRows[0].IsSubagent || boxRows[0].A2ATaskID() != "" || boxRows[0].ParentSessionID != "" {
		t.Fatalf("ordinary peer was marked as subagent: %+v %+v", boxRows[0], boxRows[0].Hierarchy)
	}
	if sub := boxRows[1]; !sub.IsSubagent || sub.ParentSessionID != parent.Ref.Session ||
		sub.ParentMachineID() != parent.Ref.Machine || sub.A2ATaskID() != tk.ID || sub.SubagentOrigin() != proto.SubagentOriginA2A {
		t.Fatalf("90-day-old A2A subagent lost provenance after restart: %+v %+v", sub, sub.Hierarchy)
	}
	// Same-machine subagent omits parent_machine_id.
	sameRows := []proto.Session{{MachineID: parent.Ref.Machine, SessionID: sameView.Target.Session, Status: proto.StatusIdle, Agent: "codex"}}
	restarted.decorateSubagents(ctx, parent.Ref.Machine, sameRows)
	if !sameRows[0].IsSubagent || sameRows[0].ParentSessionID != parent.Ref.Session || sameRows[0].ParentMachineID() != "" ||
		sameRows[0].SubagentOrigin() != proto.SubagentOriginA2A {
		t.Fatalf("same-machine subagent provenance wrong: %+v %+v", sameRows[0], sameRows[0].Hierarchy)
	}

	// Put decorated rows back into fakeHub so a2aDiscover / a2aDeliver see IsSubagent=true.
	h.mu.Lock()
	h.sessions["box"] = boxRows
	h.mu.Unlock()

	// 6. Subagent excluded from peer discovery & unsolicited peer send, YET allowed on its own task!
	disc := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_sessions", json.RawMessage(`{}`), false)
	if disc.IsError || strings.Contains(resultText(disc), subRef.Session) || !strings.Contains(resultText(disc), peer.Session) {
		t.Fatalf("a2a_sessions leaked subagent or missed peer: %s", resultText(disc))
	}
	if _, err := restarted.a2aStart(ctx, st, cfg, parent, subRef, "m-unsolicited", "", "Direct ping.", false, nil); !errors.Is(err, errA2AUnavailable) {
		t.Fatalf("unsolicited peer send to subagent got %v, want errA2AUnavailable", err)
	}
	tools, err := restarted.sessionMCPToolsChecked(ctx, subRef.Machine, subRef.Session, false, false)
	if err != nil || !toolListed(tools, "a2a_report") || !toolListed(tools, "a2a_get") {
		t.Fatalf("A2A subagent missing A2A tools: err=%v", err)
	}
	repArgs, _ := json.Marshal(map[string]any{"task_id": tk.ID, "message_id": "r-ask", "state": a2aInput, "text": "Which target?"})
	if r := restarted.mcpCall(ctx, subRef.Machine, subRef.Session, "a2a_report", repArgs, false); r.IsError {
		t.Fatalf("A2A subagent a2a_report failed: %s", resultText(r))
	}
	ansArgs, _ := json.Marshal(map[string]any{"task_id": tk.ID, "message_id": "p-ans", "text": "Use integration."})
	if r := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", ansArgs, false); r.IsError {
		t.Fatalf("parent answer to subagent failed: %s", resultText(r))
	}
	tk = processMemA2A(t, restarted, st, cfg, tk.ID)
	if tk.State != a2aWorking || len(h.sentCalls()) == 0 || !strings.Contains(string(h.sentCalls()[len(h.sentCalls())-1].Params), "Use integration.") {
		t.Fatalf("follow-up was not delivered to IsSubagent=true target: state=%s sends=%+v", tk.State, h.sentCalls())
	}
	// Depth-1 guard still prevents subagent from launching a grandchild.
	gcArgs, _ := json.Marshal(map[string]any{"machine_id": "mac", "cwd": "/code/app", "message_id": "m-gc", "text": "Grandchild."})
	if r := restarted.mcpCall(ctx, subRef.Machine, subRef.Session, "a2a_send", gcArgs, false); !r.IsError || !strings.Contains(resultText(r), "does not dispatch") {
		t.Fatalf("subagent bypassed depth-1 guard: %s", resultText(r))
	}
	doneArgs, _ := json.Marshal(map[string]any{"task_id": tk.ID, "message_id": "r-done", "state": a2aComplete, "text": "All green."})
	if r := restarted.mcpCall(ctx, subRef.Machine, subRef.Session, "a2a_report", doneArgs, false); r.IsError {
		t.Fatalf("subagent completion report failed: %s", resultText(r))
	}

	// 7. Offline queued launch fails IMMEDIATELY when agents.a2a.launch=false (even while target is still
	// offline), without affecting already-attempted launches or ordinary peer messages.
	h.mu.Lock()
	h.offline = map[string]bool{"box": true}
	h.mu.Unlock()
	rawQueued, _ := json.Marshal(map[string]any{"machine_id": "box", "cwd": "/code/app", "message_id": "m-queued-offline", "text": "Run when box returns."})
	resQueued := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawQueued, false)
	if resQueued.IsError {
		t.Fatalf("offline queued launch failed to enqueue: %s", resultText(resQueued))
	}
	var queuedView a2aTaskView
	if err := json.Unmarshal([]byte(resultText(resQueued)), &queuedView); err != nil {
		t.Fatal(err)
	}
	// Also enqueue a second launch and mark it already attempted (a2aSending) to verify launch=false does not clobber it.
	rawInflight, _ := json.Marshal(map[string]any{"machine_id": "box", "cwd": "/code/app", "message_id": "m-inflight-offline", "text": "Already sent."})
	resInflight := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawInflight, false)
	if resInflight.IsError {
		t.Fatalf("inflight launch enqueue failed: %s", resultText(resInflight))
	}
	var inflightView a2aTaskView
	if err := json.Unmarshal([]byte(resultText(resInflight)), &inflightView); err != nil {
		t.Fatal(err)
	}
	inflightTask, err := decodeA2A(st.A2AGet(ctx, inflightView.ID))
	if err != nil || inflightTask == nil {
		t.Fatalf("load inflight task: %v", err)
	}
	inflightTask.Events[0].Delivery = a2aSending
	inflightTask.Events[0].Attempted = time.Now().UTC()
	if err := restarted.a2aSave(ctx, st, inflightTask); err != nil {
		t.Fatal(err)
	}

	startsBefore := len(h.starts)
	off := false
	h.hello.Agents.A2A = assistantwire.A2AConfig{Launch: &off}
	// Target machine "box" is STILL OFFLINE: never-attempted queued launch must fail right away.
	queuedDone := processMemA2A(t, restarted, st, restarted.a2aConfig(ctx), queuedView.ID)
	if queuedDone.State != a2aFailed || queuedDone.Launch.Pending || len(h.starts) != startsBefore {
		t.Fatalf("disabled offline queued launch did not fail immediately before online gate: state=%s pending=%v starts=%d (was %d)",
			queuedDone.State, queuedDone.Launch.Pending, len(h.starts), startsBefore)
	}
	// Already-attempted launch stays pending reconciliation while offline.
	inflightAfter := processMemA2A(t, restarted, st, restarted.a2aConfig(ctx), inflightView.ID)
	if inflightAfter.State == a2aFailed || !inflightAfter.Launch.Pending {
		t.Fatalf("already-attempted offline launch was prematurely failed by launch=false: state=%s pending=%v",
			inflightAfter.State, inflightAfter.Launch.Pending)
	}
	h.mu.Lock()
	h.offline = nil
	h.mu.Unlock()

	// 8. Config opt-outs: Launch=false disables new launches while preserving peer discovery; Machines=[] disables all.
	rawDisabled, _ := json.Marshal(map[string]any{"machine_id": "box", "cwd": "/code/app", "message_id": "m-off", "text": "No."})
	if r := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawDisabled, false); !r.IsError {
		t.Fatalf("Launch=false allowed launch: %s", resultText(r))
	}
	if r := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_sessions", json.RawMessage(`{}`), false); r.IsError {
		t.Fatalf("Launch=false broke discovery: %s", resultText(r))
	}
	h.hello.Agents.A2A = assistantwire.A2AConfig{Machines: []string{}}
	if r := restarted.mcpCall(ctx, parent.Ref.Machine, parent.Ref.Session, "a2a_send", rawDisabled, false); !r.IsError {
		t.Fatalf("Machines=[] allowed launch: %s", resultText(r))
	}
	_ = slices.Contains(proto.PermissionModes, "auto")
}

// End-to-end manager mcp.call envelope verification for a2a_send live SourcePermission attestation:
// bypass permits acceptEdits, prompting permits default and rejects acceptEdits, missing/mismatched fails closed.
func TestA2ASendNodeRequestLiveSourcePermission(t *testing.T) {
	ctx := context.Background()
	s, h, _, parent, _ := memA2AFixture(t)
	d := newFleetDevs()
	d.add("mac", "Mac")
	d.add("box", "Box")
	d.setSessions("mac", h.sessions["mac"])
	d.setSessions("box", h.sessions["box"])
	s.devs = d
	call := func(args map[string]any, proof proto.SourcePermission) proto.ToolResult {
		t.Helper()
		rawArgs, _ := json.Marshal(args)
		env := map[string]any{
			"name":       "a2a_send",
			"session_id": parent.Ref.Session,
			"args":       json.RawMessage(rawArgs),
		}
		if proof.Valid() {
			env["source_permission"] = proof
		}
		rawEnv, _ := json.Marshal(env)
		out, handled, err := s.NodeRequest(ctx, parent.Ref.Machine, "mcp.call", rawEnv)
		if err != nil || !handled {
			t.Fatalf("NodeRequest mcp.call: handled=%v err=%v", handled, err)
		}
		return out.(proto.ToolResult)
	}

	argsEdit := map[string]any{"machine_id": "box", "cwd": "/code/app", "permission_mode": "acceptEdits", "message_id": "m-nr-1", "text": "Edit."}
	rawEdit, _ := json.Marshal(argsEdit)
	// Missing proof fails closed.
	if res := call(argsEdit, proto.SourcePermission{}); !res.IsError {
		t.Fatalf("missing attestation allowed acceptEdits: %s", resultText(res))
	}
	// Prompting proof rejects acceptEdits...
	if res := call(argsEdit, testSourcePermission(parent.Ref.Session, "a2a_send", rawEdit, "prompting")); !res.IsError {
		t.Fatalf("prompting attestation allowed acceptEdits: %s", resultText(res))
	}
	// ...and accepts default.
	argsDef := map[string]any{"machine_id": "box", "cwd": "/code/app", "permission_mode": "default", "message_id": "m-nr-2", "text": "Check."}
	rawDef, _ := json.Marshal(argsDef)
	if res := call(argsDef, testSourcePermission(parent.Ref.Session, "a2a_send", rawDef, "prompting")); res.IsError {
		t.Fatalf("prompting attestation rejected default: %s", resultText(res))
	}
	// Bypass proof accepts acceptEdits.
	if res := call(argsEdit, testSourcePermission(parent.Ref.Session, "a2a_send", rawEdit, "bypass")); res.IsError {
		t.Fatalf("bypass attestation rejected acceptEdits: %s", resultText(res))
	}
	// Mismatched digest fails closed.
	wrongDigest := testSourcePermission(parent.Ref.Session, "a2a_send", json.RawMessage(`{}`), "bypass")
	argsEdit2 := map[string]any{"machine_id": "box", "cwd": "/code/app", "permission_mode": "acceptEdits", "message_id": "m-nr-3", "text": "Edit2."}
	if res := call(argsEdit2, wrongDigest); !res.IsError {
		t.Fatalf("mismatched digest attestation allowed acceptEdits: %s", resultText(res))
	}
}

// Warm refreshes over an unchanged live + archived session list must make zero A2ALaunchesForTargets
// queries, and pruning drops only removed sessions from that machine's bucket without affecting other machines.
func TestSubagentCheckedWarmRefreshZeroQueriesAndPerMachinePrune(t *testing.T) {
	ctx := context.Background()
	s, _, st, _, _ := memA2AFixture(t)
	// Seed one known A2A subagent on mac.
	body, _ := json.Marshal(a2aBody{Launch: &a2aLaunch{CWD: "/code/app", Subagent: true}})
	if _, err := st.A2ACreate(ctx, db.A2ARow{
		ID: "task-warm-1", Owner: "mac/lead", Request: "req-warm-1", Context: "ctx-warm-1",
		SourceMachine: "mac", SourceSession: "lead", TargetMachine: "mac", TargetSession: "sub-1",
		State: a2aWorking, Body: body,
	}); err != nil {
		t.Fatal(err)
	}

	buildComplete := func(liveIDs, archIDs []string) []proto.Session {
		live := make([]proto.Session, 0, len(liveIDs))
		for _, id := range liveIDs {
			live = append(live, proto.Session{MachineID: "mac", SessionID: id, Status: proto.StatusIdle, Cwd: "/code/app", Agent: "claude"})
		}
		list := s.decorateInventory("mac", live, true)
		for _, id := range archIDs {
			list = append(list, proto.Session{MachineID: "mac", SessionID: id, Status: proto.StatusDone, Archived: true, Cwd: "/code/app", Agent: "claude"})
		}
		s.foldInventory("mac", list)
		return list
	}

	// Prime another machine's bucket to verify per-machine pruning never touches it.
	s.decorateSubagents(ctx, "box", []proto.Session{{MachineID: "box", SessionID: "box-live-1", Status: proto.StatusIdle}})

	// Pass 1: cold pass queries mac live + archived rows (at most 2 queries: live then archived).
	rows1 := buildComplete([]string{"live-1", "live-2", "sub-1"}, []string{"arch-1"})
	if !rows1[2].IsSubagent || rows1[2].A2ATaskID() != "task-warm-1" {
		t.Fatalf("sub-1 not decorated on cold pass: %+v %+v", rows1[2], rows1[2].Hierarchy)
	}
	st.mu.Lock()
	afterCold := st.launchQueries
	st.mu.Unlock()
	if afterCold == 0 {
		t.Fatal("expected cold pass to query A2ALaunchesForTargets")
	}

	// Pass 2: unchanged warm refresh (live + archived) MUST perform ZERO A2ALaunchesForTargets queries.
	_ = buildComplete([]string{"live-1", "live-2", "sub-1"}, []string{"arch-1"})
	st.mu.Lock()
	afterWarm := st.launchQueries
	st.mu.Unlock()
	if afterWarm != afterCold {
		t.Fatalf("warm refresh queried A2ALaunchesForTargets %d extra times (cold=%d warm=%d); archived negative cache was pruned prematurely",
			afterWarm-afterCold, afterCold, afterWarm)
	}

	// Pass 3: removing live-2 from mac prunes only mac/live-2 while keeping mac/arch-1, mac/sub-1, and box/box-live-1.
	_ = buildComplete([]string{"live-1", "sub-1"}, []string{"arch-1"})
	s.fleet.subagentsMu.RLock()
	_, macLive1 := s.fleet.subagentsChecked["mac"]["live-1"]
	_, macLive2 := s.fleet.subagentsChecked["mac"]["live-2"]
	_, macArch1 := s.fleet.subagentsChecked["mac"]["arch-1"]
	_, macSub1 := s.fleet.subagentsChecked["mac"]["sub-1"]
	_, boxLive1 := s.fleet.subagentsChecked["box"]["box-live-1"]
	s.fleet.subagentsMu.RUnlock()
	if !macLive1 || macLive2 || !macArch1 || !macSub1 || !boxLive1 {
		t.Fatalf("per-machine prune state wrong: macLive1=%v macLive2=%v macArch1=%v macSub1=%v boxLive1=%v",
			macLive1, macLive2, macArch1, macSub1, boxLive1)
	}
}

type legacySpawnTodoStore struct {
	*memA2AStore
	todoStore
	agentsMu     sync.Mutex
	todos        []db.TodoRow
	agents       []db.TodoAgentRow
	agentsErr    error
	agentsCalls  int
	listTodosHit int
}

func (st *legacySpawnTodoStore) ListTodos(context.Context) ([]db.TodoRow, error) {
	st.agentsMu.Lock()
	defer st.agentsMu.Unlock()
	st.listTodosHit++
	return slices.Clone(st.todos), nil
}

func (st *legacySpawnTodoStore) ListAllTodoSpaces(context.Context) ([]db.TodoSpaceRow, error) {
	return nil, nil
}

func (st *legacySpawnTodoStore) ListTodoThreads(context.Context) (map[string]db.TodoThread, error) {
	return map[string]db.TodoThread{}, nil
}

func (st *legacySpawnTodoStore) ListTodoSources(context.Context) (map[string]db.TodoSource, error) {
	return map[string]db.TodoSource{}, nil
}

func (st *legacySpawnTodoStore) ListAllTodoAgents(context.Context) ([]db.TodoAgentRow, error) {
	st.agentsMu.Lock()
	defer st.agentsMu.Unlock()
	st.agentsCalls++
	if st.agentsErr != nil {
		return nil, st.agentsErr
	}
	return slices.Clone(st.agents), nil
}

// Legacy task_spawn subagent provenance restores directly from todo_agents (or already-loaded
// in-memory todos) without invoking ensureTodosLoaded, keeping decorateInventory free of todo
// startup side effects and call-graph cycles (#14377).
func TestLegacySpawnedSubagentLoadsWithoutInitializingTodos(t *testing.T) {
	ctx := context.Background()
	st := &legacySpawnTodoStore{
		memA2AStore: newMemA2AStore(),
		todos:       []db.TodoRow{{ID: "t1", Title: "Parent task"}},
		agents: []db.TodoAgentRow{
			{TodoID: "t1", MachineID: "box", SessionID: "spawn-cross", Source: sourceSpawned, Via: "mac/lead"},
			{TodoID: "t1", MachineID: "mac", SessionID: "spawn-local", Source: sourceSpawned, Via: "mac/lead"},
			{TodoID: "t1", MachineID: "box", SessionID: "manual-peer", Source: "manual", Via: "mac/lead"},
			{TodoID: "t1", MachineID: "box", SessionID: "bad-via", Source: sourceSpawned, Via: "no-slash"},
		},
		agentsErr: errors.New("transient todo_agents read error"),
	}
	s := New(Options{Hub: newFakeHub(), Store: func() Store { return st }, Logf: testLogf(t)})

	// 1. Transient read failure retries on the next call and does not load full todos.
	rows := []proto.Session{
		{MachineID: "box", SessionID: "spawn-cross", Status: proto.StatusWorking},
		{MachineID: "box", SessionID: "manual-peer", Status: proto.StatusIdle},
		{MachineID: "box", SessionID: "bad-via", Status: proto.StatusIdle},
	}
	s.decorateSubagents(ctx, "box", rows)
	if rows[0].IsSubagent {
		t.Fatalf("expected transient error to leave link unloaded, got %+v", rows[0].Hierarchy)
	}
	s.fleet.subagentsMu.RLock()
	loadedAfterErr := s.fleet.subagentsLegacyLoaded
	s.fleet.subagentsMu.RUnlock()
	if loadedAfterErr {
		t.Fatal("subagentsLegacyLoaded became true despite ListAllTodoAgents error")
	}

	// 2. Next call recovers both cross-machine and same-machine task_spawn provenance directly
	// without calling ListTodos or marking s.todos.loaded.
	st.agentsMu.Lock()
	st.agentsErr = nil
	st.agentsMu.Unlock()
	s.decorateSubagents(ctx, "box", rows)
	if !rows[0].IsSubagent || rows[0].ParentSessionID != "lead" || rows[0].ParentMachineID() != "mac" ||
		rows[0].SubagentOrigin() != proto.SubagentOriginSpawned {
		t.Fatalf("cross-machine task_spawn provenance wrong: %+v %+v", rows[0], rows[0].Hierarchy)
	}
	if rows[1].IsSubagent || rows[2].IsSubagent {
		t.Fatalf("non-spawned or malformed via row tagged: manual=%+v bad=%+v", rows[1].Hierarchy, rows[2].Hierarchy)
	}
	localRows := []proto.Session{{MachineID: "mac", SessionID: "spawn-local", Status: proto.StatusWorking}}
	s.decorateSubagents(ctx, "mac", localRows)
	if !localRows[0].IsSubagent || localRows[0].ParentSessionID != "lead" || localRows[0].ParentMachineID() != "" ||
		localRows[0].SubagentOrigin() != proto.SubagentOriginSpawned {
		t.Fatalf("same-machine task_spawn provenance wrong: %+v %+v", localRows[0], localRows[0].Hierarchy)
	}
	s.todos.mu.RLock()
	todosLoaded := s.todos.loaded
	s.todos.mu.RUnlock()
	st.agentsMu.Lock()
	agentsCalls, listTodosHit := st.agentsCalls, st.listTodosHit
	st.agentsMu.Unlock()
	if todosLoaded || listTodosHit != 0 {
		t.Fatalf("decorateSubagents initialized todos: todosLoaded=%v listTodosHit=%d", todosLoaded, listTodosHit)
	}
	if agentsCalls != 2 {
		t.Fatalf("ListAllTodoAgents calls = %d, want 2 (1 failed + 1 cached success)", agentsCalls)
	}

	// 3. When todos are already loaded in memory, ensureLegacySubagentsLoaded reads them with zero DB queries.
	st2 := &legacySpawnTodoStore{
		memA2AStore: newMemA2AStore(),
		todos:       []db.TodoRow{{ID: "t2", Title: "In-memory parent task"}},
		agents: []db.TodoAgentRow{
			{TodoID: "t2", MachineID: "box", SessionID: "mem-spawn", Source: sourceSpawned, Via: "mac/lead"},
		},
	}
	s2 := New(Options{Hub: newFakeHub(), Store: func() Store { return st2 }, Logf: testLogf(t)})
	s2.todos.mu.Lock()
	s2.todos.loaded = true
	s2.todos.todos = map[string]*Todo{
		"t2": {ID: "t2", Agents: []TodoAgent{{MachineID: "box", SessionID: "mem-spawn", Source: sourceSpawned, Via: "mac/lead"}}},
	}
	s2.todos.mu.Unlock()
	memRows := []proto.Session{{MachineID: "box", SessionID: "mem-spawn", Status: proto.StatusWorking}}
	s2.decorateSubagents(ctx, "box", memRows)
	if !memRows[0].IsSubagent || memRows[0].ParentSessionID != "lead" || memRows[0].ParentMachineID() != "mac" ||
		memRows[0].SubagentOrigin() != proto.SubagentOriginSpawned {
		t.Fatalf("in-memory todo spawned provenance wrong: %+v %+v", memRows[0], memRows[0].Hierarchy)
	}
	st2.agentsMu.Lock()
	st2Calls := st2.agentsCalls
	st2.agentsMu.Unlock()
	if st2Calls != 0 {
		t.Fatalf("already-loaded todos still queried ListAllTodoAgents %d times", st2Calls)
	}
}

func (m *memA2AStore) launchCounts() (queries, targets int, hits map[[2]string]int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.launchQueries, m.launchTargets, maps.Clone(m.launchTargetHit)
}

func saveTestAgentArchives(t *testing.T, s *Service, records map[string]agentArchive) {
	t.Helper()
	ctx := context.Background()
	if err := s.agentArchives.lock(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.agentArchives.unlock()
	if err := s.loadAgentArchivesLocked(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.saveAgentArchivesLocked(ctx, maps.Clone(records)); err != nil {
		t.Fatal(err)
	}
}

func hasCheckedSession(s *Service, machine, sid string) bool {
	s.fleet.subagentsMu.RLock()
	defer s.fleet.subagentsMu.RUnlock()
	_, ok := s.fleet.subagentsChecked[machine][sid]
	return ok
}

// Alternating decoratedApart (publishList when ArchivedApart=true) and decoratedInto (liveLoop)
// must not ping-pong archived negative entries in subagentsChecked: archived.rows and archive-only
// keys remain retained while present, true removals of archived or live sessions still prune,
// positive subagent hits and other machines stay untouched, and archived rows never enter shown
// or foldMeta.
func TestDecoratedApartIntoNoSubagentPingPong(t *testing.T) {
	ctx := context.Background()
	st := newMemA2AStore()
	f := newFakeHub()
	f.hello.ArchivedApart = true
	d := newFleetDevs()
	d.add("mac", "Mac")
	d.add("box", "Box")
	s := New(Options{Hub: f, Devices: d, Store: func() Store { return st }, Logf: testLogf(t)})

	// Seed one live positive A2A subagent and one archive-only positive A2A subagent on mac,
	// plus a cross-machine child on box pointing to mac/lead so foldMeta["mac"] is exercised.
	body, _ := json.Marshal(a2aBody{Launch: &a2aLaunch{CWD: "/code/app", Subagent: true}})
	for _, row := range []db.A2ARow{
		{
			ID: "task-live-1", Owner: "mac/lead", Request: "req-live-1", Context: "ctx-live-1",
			SourceMachine: "mac", SourceSession: "lead", TargetMachine: "mac", TargetSession: "sub-live",
			State: a2aWorking, Body: body,
		},
		{
			ID: "task-arch-1", Owner: "mac/lead", Request: "req-arch-1", Context: "ctx-arch-1",
			SourceMachine: "mac", SourceSession: "lead", TargetMachine: "mac", TargetSession: "sub-arch-only",
			State: a2aComplete, Body: body,
		},
		{
			ID: "task-cross-1", Owner: "mac/lead", Request: "req-cross-1", Context: "ctx-cross-1",
			SourceMachine: "mac", SourceSession: "lead", TargetMachine: "box", TargetSession: "box-cross-sub",
			State: a2aWorking, Body: body,
		},
	} {
		if _, err := st.A2ACreate(ctx, row); err != nil {
			t.Fatal(err)
		}
	}

	at := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	mkRow := func(machine, id string) proto.Session {
		return proto.Session{
			MachineID: machine, SessionID: id, Status: proto.StatusIdle,
			Cwd: "/code/app", Agent: "claude", UpdatedAt: at,
		}
	}

	macLive := []proto.Session{
		mkRow("mac", "lead"),
		mkRow("mac", "live-removable"),
		mkRow("mac", "sub-live"),
		mkRow("mac", "arch-live-1"),
		mkRow("mac", "arch-live-removable"),
	}
	boxLive := []proto.Session{
		mkRow("box", "box-live-1"),
		mkRow("box", "box-cross-sub"),
	}
	d.setSessions("mac", macLive)
	d.setSessions("box", boxLive)

	records := map[string]agentArchive{
		runtimeListID("mac", "arch-live-1"):         {Session: archiveSnapshot(mkRow("mac", "arch-live-1")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("mac", "arch-live-removable"): {Session: archiveSnapshot(mkRow("mac", "arch-live-removable")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("mac", "arch-only-1"):         {Session: archiveSnapshot(mkRow("mac", "arch-only-1")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("mac", "arch-only-removable"): {Session: archiveSnapshot(mkRow("mac", "arch-only-removable")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("mac", "sub-arch-only"):       {Session: archiveSnapshot(mkRow("mac", "sub-arch-only")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("mac", "restored-only-1"):     {Session: archiveSnapshot(mkRow("mac", "restored-only-1")), Archived: false, ChangedAt: at.Add(time.Hour)},
		// box records include a colliding session ID ("live-removable") to verify cross-machine isolation.
		runtimeListID("box", "box-arch-only"):  {Session: archiveSnapshot(mkRow("box", "box-arch-only")), Archived: true, ChangedAt: at.Add(time.Hour)},
		runtimeListID("box", "live-removable"): {Session: archiveSnapshot(mkRow("box", "live-removable")), Archived: true, ChangedAt: at.Add(time.Hour)},
	}
	if err := st.PutSetting(ctx, agentArchivesKey, records); err != nil {
		t.Fatal(err)
	}

	// 1. Cold load box first so its bucket and cross-machine fold edge are established.
	_ = s.decoratedInto("box", nil)
	_, _ = s.decoratedApart("box", s.archiveMark())
	for _, sid := range []string{"box-live-1", "box-cross-sub", "box-arch-only", "live-removable"} {
		if !hasCheckedSession(s, "box", sid) {
			t.Fatalf("box/%s not cached after cold load", sid)
		}
	}

	// 2. Cold load mac via decoratedApart then decoratedInto.
	shown, archived := s.decoratedApart("mac", s.archiveMark())
	shownIDs := make(map[string]bool, len(shown))
	for _, r := range shown {
		if r.Archived && !r.Assistant {
			t.Fatalf("decoratedApart leaked archived row %q into shown", r.SessionID)
		}
		shownIDs[r.SessionID] = true
	}
	for _, want := range []string{"lead", "live-removable", "sub-live", "restored-only-1"} {
		if !shownIDs[want] {
			t.Fatalf("shown missing %q: %v", want, shownIDs)
		}
	}
	for _, forbid := range []string{"arch-live-1", "arch-live-removable", "arch-only-1", "arch-only-removable", "sub-arch-only"} {
		if shownIDs[forbid] {
			t.Fatalf("archived session %q leaked into shown", forbid)
		}
	}
	if len(archived.rows) != 2 || len(archived.keys) != 3 {
		t.Fatalf("unexpected archived split: rows=%d keys=%d", len(archived.rows), len(archived.keys))
	}
	for _, r := range archived.rows {
		if r.FoldedUnder() != "" || r.Children() != (proto.SessionChildren{}) {
			t.Fatalf("archived row %q unexpectedly folded: under=%q children=%+v", r.SessionID, r.FoldedUnder(), r.Children())
		}
	}
	leadRow := rowNamed(shown, "lead")
	if leadRow == nil || leadRow.Children().Total != 2 {
		t.Fatalf("lead children = %+v, want Total=2 (mac/sub-live + box/box-cross-sub)", leadRow)
	}
	// Verify foldMeta["mac"] excludes archived rows and archive-only keys.
	s.fleet.foldMu.Lock()
	metaIDs := map[string]bool{}
	for _, e := range s.fleet.foldMeta["mac"] {
		metaIDs[e.sessionID] = true
	}
	s.fleet.foldMu.Unlock()
	if len(metaIDs) == 0 {
		t.Fatal("expected foldMeta[mac] to be populated for cross-machine fold")
	}
	for _, forbid := range []string{"arch-live-1", "arch-live-removable", "arch-only-1", "arch-only-removable", "sub-arch-only"} {
		if metaIDs[forbid] {
			t.Fatalf("archived session %q entered foldMeta[mac]", forbid)
		}
	}

	whole := s.decoratedInto("mac", nil)
	subArchRow := rowNamed(whole, "sub-arch-only")
	if subArchRow == nil || !subArchRow.IsSubagent || subArchRow.A2ATaskID() != "task-arch-1" {
		t.Fatalf("sub-arch-only missing subagent provenance in decoratedInto: %+v", subArchRow)
	}

	coldQueries, coldTargets, coldHits := st.launchCounts()
	if coldQueries == 0 {
		t.Fatal("expected cold passes to query A2ALaunchesForTargets")
	}

	// 3. Repeated alternating decoratedApart / decoratedInto must do ZERO A2ALaunchesForTargets queries.
	var buf []proto.Session
	for round := range 5 {
		shown, archived = s.decoratedApart("mac", s.archiveMark())
		if len(shown) != 4 || len(archived.rows) != 2 || len(archived.keys) != 3 {
			t.Fatalf("round %d apart counts changed: shown=%d rows=%d keys=%d", round, len(shown), len(archived.rows), len(archived.keys))
		}
		buf = s.decoratedInto("mac", buf)
	}
	// Back-to-back calls in each direction must also stay at zero queries.
	_, _ = s.decoratedApart("mac", s.archiveMark())
	_, _ = s.decoratedApart("mac", s.archiveMark())
	buf = s.decoratedInto("mac", buf)
	buf = s.decoratedInto("mac", buf)

	warmQueries, warmTargets, warmHits := st.launchCounts()
	if warmQueries != coldQueries || warmTargets != coldTargets {
		t.Fatalf("ping-pong queried A2ALaunchesForTargets %d extra times (%d extra targets) after cold load: coldHits=%v warmHits=%v",
			warmQueries-coldQueries, warmTargets-coldTargets, coldHits, warmHits)
	}
	for _, sid := range []string{"arch-live-1", "arch-live-removable", "arch-only-1", "arch-only-removable"} {
		if warmHits[[2]string{"mac", sid}] != coldHits[[2]string{"mac", sid}] {
			t.Fatalf("archived negative entry mac/%s re-queried: cold=%d warm=%d",
				sid, coldHits[[2]string{"mac", sid}], warmHits[[2]string{"mac", sid}])
		}
	}

	// 4. Removing a live session prunes only mac/live-removable (even though box has an archived "live-removable").
	d.setSessions("mac", []proto.Session{
		mkRow("mac", "lead"),
		mkRow("mac", "sub-live"),
		mkRow("mac", "arch-live-1"),
		mkRow("mac", "arch-live-removable"),
	})
	_, _ = s.decoratedApart("mac", s.archiveMark())
	if hasCheckedSession(s, "mac", "live-removable") {
		t.Fatal("removed live session mac/live-removable was not pruned")
	}
	for _, kept := range []string{"lead", "sub-live", "arch-live-1", "arch-live-removable", "arch-only-1", "arch-only-removable", "sub-arch-only", "restored-only-1"} {
		if !hasCheckedSession(s, "mac", kept) {
			t.Fatalf("mac/%s was prematurely pruned after removing live-removable", kept)
		}
	}
	for _, boxSID := range []string{"box-live-1", "box-cross-sub", "box-arch-only", "live-removable"} {
		if !hasCheckedSession(s, "box", boxSID) {
			t.Fatalf("other machine box/%s was affected by mac prune", boxSID)
		}
	}

	// 5. Removing both a node-listed archived session and an archive-only session prunes both from mac,
	// while keeping remaining archived entries, positive subagent hits, and box untouched.
	d.setSessions("mac", []proto.Session{
		mkRow("mac", "lead"),
		mkRow("mac", "sub-live"),
		mkRow("mac", "arch-live-1"),
	})
	delete(records, runtimeListID("mac", "arch-live-removable"))
	delete(records, runtimeListID("mac", "arch-only-removable"))
	delete(records, runtimeListID("mac", "sub-arch-only"))
	saveTestAgentArchives(t, s, records)

	_, _ = s.decoratedApart("mac", s.archiveMark())
	if hasCheckedSession(s, "mac", "arch-live-removable") {
		t.Fatal("removed node-listed archived session mac/arch-live-removable was not pruned")
	}
	if hasCheckedSession(s, "mac", "arch-only-removable") {
		t.Fatal("removed archive-only session mac/arch-only-removable was not pruned")
	}
	// Positive subagent cache hit stays retained even after the archive record is removed.
	if !hasCheckedSession(s, "mac", "sub-arch-only") {
		t.Fatal("positive subagent hit mac/sub-arch-only was pruned")
	}
	for _, kept := range []string{"lead", "sub-live", "arch-live-1", "arch-only-1", "restored-only-1"} {
		if !hasCheckedSession(s, "mac", kept) {
			t.Fatalf("mac/%s was prematurely pruned after archive removal", kept)
		}
	}
	for _, boxSID := range []string{"box-live-1", "box-cross-sub", "box-arch-only", "live-removable"} {
		if !hasCheckedSession(s, "box", boxSID) {
			t.Fatalf("other machine box/%s was affected by mac archive prune", boxSID)
		}
	}

	afterPruneQueries, _, _ := st.launchCounts()
	if afterPruneQueries != coldQueries {
		t.Fatalf("removals triggered unexpected A2ALaunchesForTargets queries: before=%d after=%d", coldQueries, afterPruneQueries)
	}

	// 6. When arch-live-1 leaves the node list while still in archive records, it transitions from
	// archived.rows to archived.keys (leaving archived.rows empty) and stays cached with zero queries;
	// removing its archive record then prunes it while keeping arch-only-1.
	d.setSessions("mac", []proto.Session{
		mkRow("mac", "lead"),
		mkRow("mac", "sub-live"),
	})
	_, archived = s.decoratedApart("mac", s.archiveMark())
	if len(archived.rows) != 0 || len(archived.keys) != 2 {
		t.Fatalf("expected 0 archived.rows and 2 archive-only keys, got rows=%d keys=%d", len(archived.rows), len(archived.keys))
	}
	if !hasCheckedSession(s, "mac", "arch-live-1") || !hasCheckedSession(s, "mac", "arch-only-1") {
		t.Fatalf("archive-only keys prematurely pruned: arch-live-1=%v arch-only-1=%v",
			hasCheckedSession(s, "mac", "arch-live-1"), hasCheckedSession(s, "mac", "arch-only-1"))
	}
	buf = s.decoratedInto("mac", buf)

	delete(records, runtimeListID("mac", "arch-live-1"))
	saveTestAgentArchives(t, s, records)

	_, archived = s.decoratedApart("mac", s.archiveMark())
	if len(archived.rows) != 0 || len(archived.keys) != 1 {
		t.Fatalf("expected 0 archived.rows and 1 archive-only key, got rows=%d keys=%d", len(archived.rows), len(archived.keys))
	}
	if hasCheckedSession(s, "mac", "arch-live-1") {
		t.Fatal("removed mac/arch-live-1 was not pruned")
	}
	if !hasCheckedSession(s, "mac", "arch-only-1") {
		t.Fatal("archive-only key mac/arch-only-1 was pruned when archived.rows was empty")
	}
	_ = s.decoratedInto("mac", buf)
	finalQueries, _, _ := st.launchCounts()
	if finalQueries != coldQueries {
		t.Fatalf("archive-only decoratedApart -> decoratedInto re-queried DB: cold=%d final=%d", coldQueries, finalQueries)
	}
}

// BenchmarkDecoratedApartIntoSubagentQueries measures A2ALaunchesForTargets query churn across
// alternating decoratedApart (publishList) and decoratedInto (liveLoop) rounds with no sleeps.
func BenchmarkDecoratedApartIntoSubagentQueries(b *testing.B) {
	ctx := context.Background()
	st := newMemA2AStore()
	f := newFakeHub()
	f.hello.ArchivedApart = true
	d := newFleetDevs()
	d.add("mac", "Mac")
	s := New(Options{Hub: f, Devices: d, Store: func() Store { return st }})

	at := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	live := make([]proto.Session, 70)
	records := map[string]agentArchive{}
	for i := range live {
		sid := fmt.Sprintf("live-%03d", i)
		live[i] = proto.Session{
			MachineID: "mac", SessionID: sid, Status: proto.StatusIdle,
			Cwd: "/code/app", Agent: "claude", UpdatedAt: at,
		}
		if i >= 50 {
			records[runtimeListID("mac", sid)] = agentArchive{
				Session: archiveSnapshot(live[i]), Archived: true, ChangedAt: at.Add(time.Hour),
			}
		}
	}
	for i := range 200 {
		sid := fmt.Sprintf("arch-only-%03d", i)
		row := proto.Session{
			MachineID: "mac", SessionID: sid, Status: proto.StatusIdle,
			Cwd: "/code/app", Agent: "claude", UpdatedAt: at,
		}
		records[runtimeListID("mac", sid)] = agentArchive{
			Session: archiveSnapshot(row), Archived: true, ChangedAt: at.Add(time.Hour),
		}
	}
	d.setSessions("mac", live)
	if err := st.PutSetting(ctx, agentArchivesKey, records); err != nil {
		b.Fatal(err)
	}

	// Cold warm-up of both paths.
	_, _ = s.decoratedApart("mac", s.archiveMark())
	buf := s.decoratedInto("mac", nil)

	startQ, startT, _ := st.launchCounts()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_, _ = s.decoratedApart("mac", s.archiveMark())
		buf = s.decoratedInto("mac", buf)
	}
	b.StopTimer()
	endQ, endT, _ := st.launchCounts()
	b.ReportMetric(float64(endQ-startQ)/float64(b.N), "queries/op")
	b.ReportMetric(float64(endT-startT)/float64(b.N), "targets/op")
}
