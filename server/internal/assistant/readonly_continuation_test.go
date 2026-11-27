package assistant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
)

type readonlyContinuationStore struct{ *profileTaskStore }

func (st *readonlyContinuationStore) TaskPlansMadeSince(context.Context, time.Time) ([]db.TaskPlanRow, error) {
	st.planMu.Lock()
	defer st.planMu.Unlock()
	out := make([]db.TaskPlanRow, 0, len(st.plans))
	for _, plan := range st.plans {
		out = append(out, plan)
	}
	return out, nil
}

// readonlyContinuationArgs is a read-only cross-launcher continuation of todo. The handoff is deliberate: continuing
// or changing its supervisor is not by itself an owner decision, while the explicit owner_step remains one.
func readonlyContinuationArgs(todo, ownerStep, supervisor string) json.RawMessage {
	task := map[string]any{
		"title": "Verify the existing fix", "prompt": "Continue with read-only verification", "machine": "box", "cwd": "/code/app",
		"launcher": "codex", "readonly": true, "permission": "plan", "role": "worker",
		"continues": todo, "continues_why": "The earlier agent stopped; verification remains",
	}
	if ownerStep != "" {
		task["owner_step"] = ownerStep
	}
	args := map[string]any{"tasks": []map[string]any{task}}
	if supervisor != "" {
		args["supervisor"] = supervisor
	}
	raw, _ := json.Marshal(args)
	return raw
}

func readonlyContinuationFixture(t *testing.T, supervisor string) (*threadEnv, Todo) {
	t.Helper()
	store := &readonlyContinuationStore{&profileTaskStore{memStore: &memStore{}, plans: map[string]db.TaskPlanRow{}}}
	e, todo, _ := setupHandoffFixture(t, store, "claude", "claude", "default", proto.Session{
		SessionID: "agent01", Status: proto.StatusIdle, State: proto.StateIdle,
	})
	e.s.mainPlansWait = false
	setSettings(t, e.s, func(v *Settings) { v.Leaders = []string{"lead1"} })
	e.f.mu.Lock()
	e.f.known["m1"], e.f.known["lead1"] = true, true
	e.f.mu.Unlock()
	e.sessions("server",
		proto.Session{SessionID: "m1", MachineID: "server", Assistant: true},
		proto.Session{SessionID: "lead1", MachineID: "server", Assistant: true})
	if err := e.s.superviseTodo(context.Background(), todo.ID, supervisor, []string{"Read-only verification reports the result"}, 30); err != nil {
		t.Fatal(err)
	}
	return e, todoNow(e.s, todo.ID)
}

func TestSupervisorReadonlyContinuationStartsAtOnce(t *testing.T) {
	for _, tc := range []struct {
		name, session, currentSupervisor, requestedSupervisor string
	}{
		{name: "main continuation assigned to a direction", session: "m1", currentSupervisor: "m1", requestedSupervisor: "lead1"},
		{name: "direction supervisor continuation", session: "lead1", currentSupervisor: "lead1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, todo := readonlyContinuationFixture(t, tc.currentSupervisor)
			before := len(e.f.pushed())
			res, err := e.s.toolTaskPlan(context.Background(), tc.session, readonlyContinuationArgs(todo.ID, "", tc.requestedSupervisor))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res, "without asking") || !strings.Contains(res, "automatic start initiated") ||
				strings.Contains(res, "needs the user's Start") || strings.Contains(res, "dispatch failed") {
				t.Fatalf("read-only continuation did not dispatch directly: %s", res)
			}
			plan, err := e.s.loadPlan(context.Background(), planIDRe.FindString(res))
			if err != nil {
				t.Fatal(err)
			}
			if plan.State != planStarted || len(plan.Tasks) != 1 || plan.Tasks[0].HandoffOperationID == "" {
				t.Fatalf("continuation plan = %+v, want a started read-only handoff", plan)
			}
			if got := e.f.pushed(); len(got) != before {
				t.Fatalf("direct continuation produced a plan_waiting push: %+v", got[before:])
			}
		})
	}
}

func TestReadonlyContinuationOwnerStepStillWaits(t *testing.T) {
	for _, step := range []string{ownerStepMoney, ownerStepOutward, ownerStepIrreversible} {
		t.Run(step, func(t *testing.T) {
			e, todo := readonlyContinuationFixture(t, "m1")
			before := len(e.f.pushed())
			res, err := e.s.toolTaskPlan(context.Background(), "m1", readonlyContinuationArgs(todo.ID, step, "lead1"))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res, "needs the user's Start") || strings.Contains(res, "without asking") {
				t.Fatalf("owner_step %q lost its owner card: %s", step, res)
			}
			plan, err := e.s.loadPlan(context.Background(), planIDRe.FindString(res))
			if err != nil {
				t.Fatal(err)
			}
			if plan.State != planOpen {
				t.Fatalf("owner_step %q plan state = %q, want open", step, plan.State)
			}
			if got := e.f.pushed(); len(got) != before+1 {
				t.Fatalf("owner_step %q pushes = %+v, want one waiting-card push", step, got[before:])
			}
		})
	}
}
