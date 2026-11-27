package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/assistantwire"
	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/screen"
)

// captureCardPushes uses the fake hub's synchronized notification channel, so no live Service field is replaced.
func captureCardPushes(e *routeEnv) chan Notification {
	e.f.mu.Lock()
	e.f.notifyCards = make(chan Notification, 128)
	ch := e.f.notifyCards
	e.f.mu.Unlock()
	return ch
}

func cardPushFor(t *testing.T, pushes <-chan Notification, id string) Notification {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case n := <-pushes:
			if n.Interaction != nil && n.Interaction.ID == id {
				return n
			}
		case <-timer.C:
			t.Fatalf("no push arrived for %s", id)
		}
	}
}

// setPushGradingCardsForTest also lets the regression run against the preceding wire contract, where the field is absent.
func setPushGradingCardsForTest(f *fakeHub) {
	f.setHello(func(h *Hello) {
		field := reflect.ValueOf(h).Elem().FieldByName("PushGradingCards")
		if field.IsValid() && field.CanSet() {
			field.SetBool(true)
		}
	})
}

func nonOwnerCardFixture(source string) proto.Interaction {
	now := time.Now().UTC()
	ix := proto.Interaction{ID: "ix_" + source, MachineID: "mac", SessionID: "standalone-" + source,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	switch source {
	case cardAgentPermission, cardToolPermission:
		ix.Kind, ix.ToolName = proto.IxPermission, "Read"
		ix.Summary = "Inspect sender, commentary, and deletegate identifiers"
	case cardAgentQuestion:
		ix = askQuestion(ix.ID, ix.SessionID)
	case cardDeviceControl:
		ix.Kind, ix.ToolName, ix.SessionTitle = proto.IxPermission, "computer_run", "Persona"
		ix.ToolInput = []byte(`{"command":"open -a Notes"}`)
	default:
		panic("unknown non-owner source " + source)
	}
	return ix
}

func prepareNonOwnerCard(e *routeEnv, ix proto.Interaction, source string) {
	if source == cardToolPermission {
		e.s.cardAsks.Store(ix.ID, cardToolPermission)
	}
	e.hold(ix)
}

func checkNonOwnerRoute(t *testing.T, e *routeEnv, ix proto.Interaction, source string, held bool) {
	t.Helper()
	if !hasRelayFrom(e.s, "conv1", source, "interaction_id="+ix.ID) {
		t.Fatalf("%s was not handed to the main conversation", source)
	}
	if _, ok := e.s.routedTo(ix.ID, "conv1", false); !ok {
		t.Fatalf("%s cannot be answered through its route", source)
	}
	stored, ok := e.s.pendingIx(ix.ID)
	if !ok {
		t.Fatalf("%s disappeared instead of remaining pending", source)
	}
	_, told := e.s.pendingCards()
	if told[ix.ID] != held {
		t.Fatalf("%s Needs you membership = %v, want %v", source, told[ix.ID], held)
	}
	if held {
		if stored.Delegating || stored.PushLevel != assistantwire.LevelP1 {
			t.Fatalf("%s stored card = delegating %v, push level %q; want an owner-visible P1 card", source, stored.Delegating, stored.PushLevel)
		}
		shown := e.lastShown(ix.ID)
		if shown.Delegating || shown.PushLevel != assistantwire.LevelP1 {
			t.Fatalf("%s shown card = delegating %v, push level %q; want an owner-visible P1 card", source, shown.Delegating, shown.PushLevel)
		}
		if !e.announced(ix.ID) {
			t.Fatalf("%s was not marked held; channel catch-up could post it", source)
		}
		return
	}
	if !stored.Delegating || stored.PushLevel == assistantwire.LevelP1 || e.announced(ix.ID) {
		t.Fatalf("%s changed legacy delivery with both switches off: %+v", source, stored)
	}
}

func checkLegacyOwnerCard(t *testing.T, e *routeEnv, ix proto.Interaction, source string, pushes <-chan Notification) {
	t.Helper()
	stored, ok := e.s.pendingIx(ix.ID)
	if !ok || stored.Delegating {
		t.Fatalf("%s did not keep its legacy owner card: %+v, pending %v", source, stored, ok)
	}
	if hasRelayFrom(e.s, "conv1", source, "interaction_id="+ix.ID) {
		t.Fatalf("%s was diverted into a queued relay with both switches off", source)
	}
	_, told := e.s.pendingCards()
	if !told[ix.ID] {
		t.Fatalf("%s disappeared from Needs you with both switches off", source)
	}
	n := cardPushFor(t, pushes, ix.ID)
	if n.Level == assistantwire.LevelP1 || n.Interaction == nil || n.Interaction.PushLevel == assistantwire.LevelP1 {
		t.Fatalf("%s legacy owner push became P1: %+v", source, n)
	}
}

func TestNonOwnerCardSourcesRouteAndGradeDeterministically(t *testing.T) {
	sources := []string{cardAgentPermission, cardAgentQuestion, cardToolPermission, cardDeviceControl}
	for _, source := range sources {
		for _, mode := range []string{"off", "quiet", "grading"} {
			t.Run(source+"/"+mode, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				ix := nonOwnerCardFixture(source)
				prepareNonOwnerCard(e, ix, source)
				pushes := captureCardPushes(e)
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
				}
				e.s.announce(ix)
				legacyRoute := source == cardAgentPermission || source == cardAgentQuestion || source == cardExtensionApproval
				if mode == "off" && !legacyRoute {
					// tool_permission and device_control had no non-owner route before grading: off keeps their
					// visible, answerable owner card instead of a delegating card hidden behind a queued relay.
					checkLegacyOwnerCard(t, e, ix, source, pushes)
				} else {
					checkNonOwnerRoute(t, e, ix, source, mode != "off")
					if mode != "off" {
						n := cardPushFor(t, pushes, ix.ID)
						if n.Kind != assistantwire.NotifyInput || n.Level != assistantwire.LevelP1 || n.Interaction.PushLevel != assistantwire.LevelP1 {
							t.Fatalf("%s push = kind %q, level %q, card level %q; want an explicit held P1", source, n.Kind, n.Level, n.Interaction.PushLevel)
						}
					}
				}
				allow := true
				res := proto.Resolution{Allow: &allow}
				if ix.Kind == proto.IxQuestion {
					res = proto.Resolution{Answers: map[string]string{ix.Questions[0].Question: "main"}}
				}
				if err := e.s.resolve(ix.ID, res); err != nil {
					t.Fatalf("%s could not be answered: %v", source, err)
				}
			})
		}
	}
}

func TestSupervisingConversationCardsNeverSelfRoute(t *testing.T) {
	for _, session := range []string{"conv1", "bg1", "lead1"} {
		for _, mode := range []string{"off", "quiet", "grading"} {
			t.Run(session+"/"+mode, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				setSettings(t, e.s, func(v *Settings) { v.BackgroundSupervisor = "bg1" })
				now := time.Now().UTC()
				ix := proto.Interaction{ID: "ix_own_" + session, MachineID: "server", SessionID: session,
					Kind: proto.IxPermission, ToolName: "Read", Summary: "Read the sender interface", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
				e.hold(ix)
				pushes := captureCardPushes(e)
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
				}
				e.s.announce(ix)
				stored, ok := e.s.pendingIx(ix.ID)
				if !ok {
					t.Fatal("the supervisor's own card disappeared")
				}
				e.s.fleet.mu.Lock()
				routed := e.s.fleet.interactions[ix.ID].route != nil
				e.s.fleet.mu.Unlock()
				if routed {
					t.Fatal("a supervising conversation's card was routed back into a supervising conversation")
				}
				for _, to := range []string{"conv1", "bg1", "lead1"} {
					if hasRelayFrom(e.s, to, cardAgentPermission, "interaction_id="+ix.ID) {
						t.Fatalf("the card was handed to %s", to)
					}
				}
				_, told := e.s.pendingCards()
				if !told[ix.ID] {
					t.Fatal("the supervisor's own card is not answerable from Needs you")
				}
				n := cardPushFor(t, pushes, ix.ID)
				if mode == "off" {
					if n.Level == assistantwire.LevelP1 || stored.Delegating {
						t.Fatalf("legacy owner delivery changed: notification level %q, card %+v", n.Level, stored)
					}
				} else if n.Level != assistantwire.LevelP1 || stored.Delegating || stored.PushLevel != assistantwire.LevelP1 {
					t.Fatalf("own non-six-class card was not held without self-routing: notification %+v, card %+v", n, stored)
				}
				allow := true
				if err := e.s.resolve(ix.ID, proto.Resolution{Allow: &allow}); err != nil {
					t.Fatalf("the owner could not answer the supervisor's own card: %v", err)
				}
			})
		}
	}
}

func ownerCardFixture(source string) proto.Interaction {
	ix := nonOwnerCardFixture(source)
	ix.ID = "ix_owner_" + source
	ix.SessionID = "standalone-owner-" + source
	switch source {
	case cardAgentPermission:
		ix.ToolName = "Bash"
		ix.Summary = "Delete the old user records"
		ix.ToolInput = []byte(`{"command":"delete the old user records"}`)
	case cardAgentQuestion:
		ix.Questions = []proto.Question{{Question: "Should I send the release announcement?", Options: []proto.QuestionOption{{Label: "Send"}, {Label: "Wait"}}}}
	case cardToolPermission:
		ix.ToolName = "shop_charge"
		ix.ToolInput = []byte(`{"item":"standard"}`)
	case cardDeviceControl:
		ix.ToolInput = []byte(`{"command":"delete the old user records"}`)
	}
	return ix
}

func TestOwnerDecisionCardsKeepP0AndNeverUseNonOwnerRoute(t *testing.T) {
	for _, source := range []string{cardAgentPermission, cardAgentQuestion, cardToolPermission, cardDeviceControl} {
		for _, mode := range []string{"off", "quiet", "grading"} {
			t.Run(source+"/"+mode, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				ix := ownerCardFixture(source)
				prepareNonOwnerCard(e, ix, source)
				pushes := captureCardPushes(e)
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
				}
				e.s.announce(ix)
				stored, ok := e.s.pendingIx(ix.ID)
				if !ok || stored.Delegating {
					t.Fatalf("owner card was swallowed or delegated: %+v, pending %v", stored, ok)
				}
				if hasRelayFrom(e.s, "conv1", source, "interaction_id="+ix.ID) {
					t.Fatal("owner-only card was handed to the non-owner route")
				}
				_, told := e.s.pendingCards()
				if !told[ix.ID] {
					t.Fatal("owner card is absent from Needs you")
				}
				n := cardPushFor(t, pushes, ix.ID)
				// An empty card level is the established wire default P0; an explicit P0 is equivalent.
				if n.Level != "" && n.Level != assistantwire.LevelP0 || n.Interaction.PushLevel == assistantwire.LevelP1 {
					t.Fatalf("owner card did not keep P0 delivery: %+v", n)
				}
				allow := true
				res := proto.Resolution{Allow: &allow}
				if ix.Kind == proto.IxQuestion {
					res = proto.Resolution{Answers: map[string]string{ix.Questions[0].Question: "Wait"}}
				}
				if err := e.s.resolve(ix.ID, res); err != nil {
					t.Fatalf("owner card could not be answered: %v", err)
				}
			})
		}
	}
}

func TestUserApprovalWordBoundariesAndOwnerQuestions(t *testing.T) {
	no := false
	for _, tc := range []struct {
		name string
		ix   proto.Interaction
		user bool
	}{
		{"sender identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Read", Summary: "Inspect sender.go"}, false},
		{"commentary identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"grep -R commentary ./internal"}`)}, false},
		{"deletegate identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"go test ./internal/deletegate"}`)}, false},
		{"comment_id identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Read", Summary: "Inspect comment_id"}, false},
		{"delete_after identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"go test ./internal/delete_after"}`)}, false},
		{"send_to identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Read", Summary: "Inspect send_to"}, false},
		{"sending_status identifier", proto.Interaction{Kind: proto.IxPermission, ToolName: "Read", Summary: "Inspect sending_status"}, false},
		{"permission sending gerund", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", Summary: "Sending the public announcement", ToolInput: []byte(`{"command":"./announce"}`)}, true},
		{"permission commenting gerund", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", Summary: "Commenting on the public issue", ToolInput: []byte(`{"command":"./announce"}`)}, true},
		{"permission deleted past tense", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", Summary: "Deleted the old records"}, true},
		{"permission commented past tense", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", Summary: "Commented on the public issue"}, true},
		{"permission paying gerund", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", Summary: "Paying the subscription invoice"}, true},
		{"question sending gerund", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Should I proceed with sending the public announcement?"}}}, true},
		{"question commenting gerund", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Should I proceed with commenting on the public issue?"}}}, true},
		{"question deleting gerund", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Should I proceed with deleting the old records?"}}}, true},
		{"React framework question", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Should this component use React or Vue?"}}}, false},
		{"send.go filename question", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Which send.go implementation should I inspect?"}}}, false},
		{"delete.go filename permission", proto.Interaction{Kind: proto.IxPermission, ToolName: "Read", Summary: "Inspect delete.go"}, false},
		{"structured React action", proto.Interaction{Kind: proto.IxPermission, ToolName: "message_react"}, true},
		{"actual outward command", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"send the release announcement"}`)}, true},
		{"actual delete command", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"delete the old records"}`)}, true},
		{"actual payment command", proto.Interaction{Kind: proto.IxPermission, ToolName: "Bash", ToolInput: []byte(`{"command":"pay the new subscription invoice"}`)}, true},
		{"attested device outward write", proto.Interaction{Kind: proto.IxPermission, ToolName: "computer_run", OutwardWrite: true}, true},
		{"ordinary question with an identifier", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Which sender interface should I inspect?"}}}, false},
		{"outward question", proto.Interaction{Kind: proto.IxQuestion, Questions: []proto.Question{{Question: "Should I comment on the public issue?"}}}, true},
		{"irreversible question", proto.Interaction{Kind: proto.IxQuestion, Reversible: &no, Questions: []proto.Question{{Question: "Proceed with the migration?"}}}, true},
		{"password form", proto.Interaction{Kind: proto.IxQuestion, Fields: []proto.Field{{Key: "password", Secret: true}}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := userApproval(tc.ix) != ""; got != tc.user {
				t.Fatalf("owner-only = %v, want %v (%q)", got, tc.user, userApproval(tc.ix))
			}
		})
	}
}

func TestUserScreenIncludesIrreversibleWarning(t *testing.T) {
	ix := proto.Interaction{Kind: proto.IxScreen, Dialog: &screen.Dialog{
		Question: "Do you want to proceed?", Warning: "This cannot be undone",
		Options: []screen.Option{{Key: "1", Label: "Yes"}, {Key: "2", Label: "No"}},
	}}
	if why := userScreen(ix); why == "" {
		t.Fatal("an irreversible terminal warning was left to the supervisor")
	}
}

func TestOwnerQuestionSkipsDelegation(t *testing.T) {
	e := newRouteEnv(t, nil, true)
	e.f.setHello(func(h *Hello) { on := true; h.Agents.Delegate.Enabled = &on })
	called := make(chan struct{}, 1)
	e.s.delegateHook = func(context.Context, DelegateParams) (DelegateResult, error) {
		called <- struct{}{}
		return DelegateResult{Answer: true}, nil
	}
	ix := ownerCardFixture(cardAgentQuestion)
	if forget := e.s.delegable(ix); forget != nil {
		forget()
		t.Fatal("an outward owner question was claimed for delegation")
	}
	select {
	case <-called:
		t.Fatal("the delegate was called synchronously for an owner question")
	default:
	}
}

func TestOwnerGerundQuestionsSkipDelegation(t *testing.T) {
	for _, text := range []string{
		"Should I proceed with sending the public announcement?",
		"Should I proceed with commenting on the public issue?",
		"Should I proceed with deleting the old records?",
		"Should I proceed with paying the subscription invoice?",
	} {
		t.Run(text, func(t *testing.T) {
			e := newRouteEnv(t, nil, true)
			e.f.setHello(func(h *Hello) { on := true; h.Agents.Delegate.Enabled = &on })
			ix := askQuestion("ix_gerund_owner", "worker-1")
			ix.Questions[0].Question = text
			if why := userApproval(ix); why == "" {
				t.Fatalf("outward question is not owner-only: %q", text)
			}
			if forget := e.s.delegable(ix); forget != nil {
				forget()
				t.Fatalf("outward question was claimed for delegation: %q", text)
			}
		})
	}
}

func TestReactFrameworkQuestionStaysDelegableAndRoutable(t *testing.T) {
	e := newRouteEnv(t, nil, true)
	e.f.setHello(func(h *Hello) { on := true; h.Agents.Delegate.Enabled = &on })
	ix := askQuestion("ix_react_framework", "worker-1")
	ix.Questions[0].Question = "Should this component use React or Vue?"
	ix.Questions[0].Options = []proto.QuestionOption{{Label: "React"}, {Label: "Vue"}}
	if why := userApproval(ix); why != "" {
		t.Fatalf("ordinary framework question became owner-only: %s", why)
	}
	if !routable(ix) {
		t.Fatal("ordinary framework question cannot use its supervisor route")
	}
	if forget := e.s.delegable(ix); forget == nil {
		t.Fatal("ordinary framework question was not delegable")
	} else {
		forget()
	}
	if why := userApproval(proto.Interaction{Kind: proto.IxPermission, ToolName: "message_react"}); why == "" {
		t.Fatal("a structured React action is no longer owner-only")
	}
}

func TestDelegateContextIsNotRoutableAfterRestart(t *testing.T) {
	ix := askQuestion("ix_delegate_context", "worker-1")
	ix.Delegate = &proto.Delegate{Reason: "The owner must decide"}
	if routable(ix) {
		t.Fatal("a question carrying owner delegate context became routable after restoration")
	}
}

func TestDelegateFallbackUsesNonOwnerRoute(t *testing.T) {
	for _, outcome := range []string{"failure", "empty", "timeout"} {
		for _, mode := range []string{"off", "quiet", "grading"} {
			t.Run(outcome+"/"+mode, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				ix := delegateQuestion("ix_delegate_" + outcome)
				ix.SessionID = "standalone-delegate-" + outcome
				e.hold(ix)
				started := make(chan struct{})
				e.s.delegateHook = func(ctx context.Context, _ DelegateParams) (DelegateResult, error) {
					close(started)
					if outcome == "timeout" {
						return DelegateResult{}, ctx.Err()
					}
					if outcome == "empty" {
						return DelegateResult{}, nil
					}
					return DelegateResult{}, errors.New("delegate unavailable")
				}
				if outcome == "timeout" {
					e.f.setHello(func(h *Hello) { h.Agents.Delegate.TimeoutSeconds = 1 })
				}
				pushes := captureCardPushes(e)
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
				}
				since := time.Now()
				if outcome == "timeout" {
					since = since.Add(-time.Hour)
				}
				done := make(chan struct{})
				go func() {
					e.s.delegateNow(ix, func() {}, since)
					close(done)
				}()
				timer := time.NewTimer(5 * time.Second)
				defer timer.Stop()
				for started != nil || done != nil {
					select {
					case <-started:
						started = nil
					case <-done:
						done = nil
					case <-timer.C:
						t.Fatal("delegate fallback did not finish")
					}
				}
				if mode == "off" {
					// A failed delegation used to escalate straight to the owner. Off keeps that path, including
					// Needs you and the answerable push, rather than a new queued non-owner route.
					checkLegacyOwnerCard(t, e, ix, cardAgentQuestion, pushes)
				} else {
					checkNonOwnerRoute(t, e, ix, cardAgentQuestion, true)
					n := cardPushFor(t, pushes, ix.ID)
					if n.Level != assistantwire.LevelP1 {
						t.Fatalf("delegate fallback push level = %q, want P1", n.Level)
					}
				}
				if err := e.s.resolve(ix.ID, proto.Resolution{Answers: map[string]string{ix.Questions[0].Question: "main"}}); err != nil {
					t.Fatalf("fallback card could not be answered: %v", err)
				}
			})
		}
	}
}

func TestHeldNonOwnerCardCanEscalateOnceToP0(t *testing.T) {
	for _, mode := range []string{"quiet", "grading"} {
		t.Run(mode, func(t *testing.T) {
			e := newRouteEnv(t, nil, false)
			ix := nonOwnerCardFixture(cardAgentPermission)
			ix.ID = "ix_held_escalate_" + mode
			ix.SessionID = "worker-1"
			e.hold(ix)
			pushes := captureCardPushes(e)
			if mode == "quiet" {
				pushQuietFor(t, e.s, true)
			} else {
				pushQuietFor(t, e.s, false)
				setPushGradingCardsForTest(e.f)
			}
			e.s.announce(ix)
			stored, ok := e.s.pendingIx(ix.ID)
			if !ok || stored.PushLevel != assistantwire.LevelP1 {
				t.Fatalf("held card = %+v, pending %v; want P1", stored, ok)
			}
			_, told := e.s.pendingCards()
			if !told[ix.ID] {
				t.Fatal("held card is not visible in Needs you before escalation")
			}
			if first := cardPushFor(t, pushes, ix.ID); first.Level != assistantwire.LevelP1 {
				t.Fatalf("initial held push = %+v, want P1", first)
			}
			args := map[string]any{"todo_id": e.todo.ID, "reason": "The owner must decide now", "recommend": "Allow", "p0": true}
			if _, err := runJSON(t, e.s, "conv1", "ask_escalate", args); err != nil {
				t.Fatalf("first held-card escalation failed: %v", err)
			}
			escalated := cardPushFor(t, pushes, ix.ID)
			if escalated.Level != assistantwire.LevelP0 || escalated.Interaction == nil || escalated.Interaction.PushLevel != assistantwire.LevelP0 {
				t.Fatalf("escalated push = %+v, want P0", escalated)
			}
			stored, ok = e.s.pendingIx(ix.ID)
			if !ok || stored.PushLevel != assistantwire.LevelP0 || stored.Delegating {
				t.Fatalf("escalated card = %+v, pending %v; want an owner P0 card", stored, ok)
			}
			if _, err := runJSON(t, e.s, "conv1", "ask_escalate", args); err == nil ||
				!strings.Contains(err.Error(), "no card waiting that the user has not been told of") {
				t.Fatalf("second escalation was not refused: %v", err)
			}
			noRepeat := time.NewTimer(100 * time.Millisecond)
			select {
			case duplicate := <-pushes:
				noRepeat.Stop()
				t.Fatalf("second escalation produced another push: %+v", duplicate)
			case <-noRepeat.C:
			}
			allow := true
			if err := e.s.resolve(ix.ID, proto.Resolution{Allow: &allow}); err != nil {
				t.Fatalf("escalated card could not be answered: %v", err)
			}
		})
	}
}

type heldRestartStore struct {
	*restoreMem
	todoStore
	row         db.TodoRow
	agents      []db.TodoAgentRow
	supervision db.TodoSupervisionRow
}

func (st *heldRestartStore) ListTodos(context.Context) ([]db.TodoRow, error) {
	return []db.TodoRow{st.row}, nil
}
func (st *heldRestartStore) ListAllTodoSpaces(context.Context) ([]db.TodoSpaceRow, error) {
	return nil, nil
}
func (st *heldRestartStore) ListAllTodoAgents(context.Context) ([]db.TodoAgentRow, error) {
	return st.agents, nil
}
func (st *heldRestartStore) ListTodoThreads(context.Context) (map[string]db.TodoThread, error) {
	return nil, nil
}
func (st *heldRestartStore) ListTodoSources(context.Context) (map[string]db.TodoSource, error) {
	return nil, nil
}
func (st *heldRestartStore) ListTodoSupervision(context.Context) ([]db.TodoSupervisionRow, error) {
	return []db.TodoSupervisionRow{st.supervision}, nil
}
func (st *heldRestartStore) PutTodoSupervision(_ context.Context, row db.TodoSupervisionRow) error {
	st.supervision = row
	return nil
}
func (st *heldRestartStore) ReviewDoneTodo(context.Context, string, string, bool, time.Time) (*db.TodoRow, bool, error) {
	return nil, false, nil
}
func (st *heldRestartStore) LinkTodoReviewer(context.Context, string, string, string, string, string, string, string, time.Time) error {
	return nil
}
func (st *heldRestartStore) InsertTodoDecision(context.Context, db.TodoDecisionRow) (bool, error) {
	return true, nil
}

func TestHeldNonOwnerCardRestartRestoresPendingWithoutReplay(t *testing.T) {
	e := newRouteEnv(t, nil, false)
	pushQuietFor(t, e.s, true)
	ix := nonOwnerCardFixture(cardAgentPermission)
	ix.ID = "ix_held_restart"
	ix.SessionID = "worker-1"
	ix.Resumable = true
	ix.PushLevel = assistantwire.LevelP0
	e.s.record(ix) // waitRegisteredInteraction records before announce; external P0 is normalized before storage.
	e.hold(ix)
	e.s.announce(ix)
	if stored, ok := e.s.pendingIx(ix.ID); !ok || stored.PushLevel != assistantwire.LevelP1 {
		t.Fatalf("initial held card = %+v, pending %v", stored, ok)
	}

	st := &heldRestartStore{
		restoreMem:  &restoreMem{fleetMem: e.st},
		row:         db.TodoRow{ID: e.todo.ID, Title: e.todo.Title, Notes: e.todo.Notes, Origin: e.todo.Origin, CreatedAt: time.Now(), UpdatedAt: time.Now()},
		supervision: e.todo.Supervision.row(e.todo.ID),
	}
	for _, agent := range e.todo.Agents {
		st.agents = append(st.agents, db.TodoAgentRow{TodoID: e.todo.ID, MachineID: agent.MachineID, SessionID: agent.SessionID,
			LinkedAt: agent.LinkedAt, ReleasedAt: agent.ReleasedAt, Title: agent.Title, Cwd: agent.Cwd, Agent: agent.Agent, Source: agent.Source})
	}
	f2 := newFakeHub()
	f2.setHello(func(h *Hello) { h.QuietPush = true })
	replayed := make(chan Notification, 1)
	f2.mu.Lock()
	f2.notifyCards = replayed
	f2.mu.Unlock()
	s2 := newRestartedService(t, Options{Hub: f2, Store: func() Store { return st }, Logf: testLogf(t), Devices: e.d})
	s2.FleetUp(context.Background())
	restored, ok := s2.pendingIx(ix.ID)
	if !ok || restored.PushLevel != assistantwire.LevelP1 {
		t.Fatalf("restored held card = %+v, pending %v", restored, ok)
	}
	if got := f2.pushed(); len(got) != 0 {
		t.Fatalf("restoring the held card replayed its push: %+v", got)
	}
	noReplay := time.NewTimer(100 * time.Millisecond)
	select {
	case duplicate := <-replayed:
		noReplay.Stop()
		t.Fatalf("restoring the held card asynchronously replayed its push: %+v", duplicate)
	case <-noReplay.C:
	}
	f2.mu.Lock()
	shown := false
	for _, event := range f2.told {
		if (event.event == assistantwire.EventFleetInteraction || event.event == assistantwire.EventFleetInteractions) && strings.Contains(string(event.params), ix.ID) {
			shown = true
		}
	}
	f2.mu.Unlock()
	if !shown {
		t.Fatal("restored held card was not shown to the apps")
	}
	_, told := s2.pendingCards()
	if !told[ix.ID] {
		t.Fatal("restored held card is absent from Needs you")
	}
	if err := s2.ensureTodosLoaded(context.Background()); err != nil {
		t.Fatal(err)
	}
	open, ok := s2.todoNow(e.todo.ID)
	if !ok || open.DoneAt != nil || open.Supervision == nil || open.Supervision.Supervisor != "conv1" {
		t.Fatalf("restart fixture did not restore the open supervised todo: %+v, found %v", open, ok)
	}
	args := map[string]any{"todo_id": e.todo.ID, "reason": "The owner must decide after restart", "recommend": "Allow", "p0": true}
	if _, err := runJSON(t, s2, "conv1", "ask_escalate", args); err != nil {
		t.Fatalf("restored held card could not be escalated: %v", err)
	}
	escalated := cardPushFor(t, replayed, ix.ID)
	if escalated.Level != assistantwire.LevelP0 || escalated.Interaction == nil || escalated.Interaction.PushLevel != assistantwire.LevelP0 {
		t.Fatalf("restored escalation = %+v, want P0", escalated)
	}
	allow := true
	if err := s2.resolve(ix.ID, proto.Resolution{Allow: &allow}); err != nil {
		t.Fatalf("restored held card could not be answered: %v", err)
	}
}

func TestOwnerCardFixturesStayHighRisk(t *testing.T) {
	for _, source := range []string{cardAgentPermission, cardAgentQuestion, cardToolPermission, cardDeviceControl} {
		if why := userApproval(ownerCardFixture(source)); why == "" {
			t.Errorf("%s positive control is no longer classified as owner-only", source)
		}
	}
	for _, source := range []string{cardAgentPermission, cardAgentQuestion, cardToolPermission, cardDeviceControl} {
		ix := nonOwnerCardFixture(source)
		if why := userApproval(ix); why != "" {
			t.Errorf("%s ordinary control is misclassified: %s", source, why)
		}
		if strings.Contains(ix.ID, "owner") {
			t.Fatal("ordinary fixture has an owner id")
		}
	}
}

func TestNodeSuppliedP0CannotBypassCardGrading(t *testing.T) {
	for _, mode := range []string{"off", "quiet", "grading"} {
		t.Run(mode, func(t *testing.T) {
			e := newRouteEnv(t, nil, true)
			ix := nonOwnerCardFixture(cardAgentPermission)
			ix.ID = "ix_node_self_p0_" + mode
			ix.PushLevel = assistantwire.LevelP0
			pushes := captureCardPushes(e)
			switch mode {
			case "quiet":
				pushQuietFor(t, e.s, true)
			case "grading":
				pushQuietFor(t, e.s, false)
				setPushGradingCardsForTest(e.f)
			}

			// onTell is an explicit publication event. Checking state only after an event avoids sleep-based polling
			// while still exercising the real nodeInteraction -> waitInteraction -> announce path.
			published := make(chan struct{}, 32)
			e.f.mu.Lock()
			e.f.onTell = func() {
				select {
				case published <- struct{}{}:
				default:
				}
			}
			e.f.mu.Unlock()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type nodeAnswer struct {
				resolution proto.Resolution
				err        error
			}
			done := make(chan nodeAnswer, 1)
			go func() {
				r, err := e.s.nodeInteraction(ctx, ix)
				done <- nodeAnswer{resolution: r, err: err}
			}()
			publishTimer := time.NewTimer(5 * time.Second)
			defer publishTimer.Stop()
			var stored, shown proto.Interaction
		waitForPublication:
			for {
				select {
				case <-published:
					if card, ok := e.shown(ix.ID); ok {
						stored, _ = e.s.pendingIx(ix.ID)
						shown = card
						break waitForPublication
					}
				case <-publishTimer.C:
					t.Fatal("node card was not published")
				}
			}
			if _, ok := e.s.routedTo(ix.ID, "conv1", false); !ok {
				t.Fatal("ordinary node card cannot be answered through its route")
			}
			switch mode {
			case "off":
				// Compatibility: the trust-boundary rewrite exists only while quiet/grading is active.
				if stored.PushLevel != assistantwire.LevelP0 || !stored.Delegating || !shown.Delegating {
					t.Fatalf("off changed legacy node delivery: stored %+v, shown %+v", stored, shown)
				}
			default:
				if stored.PushLevel != assistantwire.LevelP1 || shown.PushLevel != assistantwire.LevelP1 || stored.Delegating || shown.Delegating {
					t.Fatalf("node supplied P0 survived grading: stored %+v, shown %+v", stored, shown)
				}
				n := cardPushFor(t, pushes, ix.ID)
				if n.Level != assistantwire.LevelP1 || n.Interaction == nil || n.Interaction.PushLevel != assistantwire.LevelP1 {
					t.Fatalf("node supplied P0 push = %+v, want held P1", n)
				}
			}
			allow := true
			if err := e.s.resolve(ix.ID, proto.Resolution{Allow: &allow}); err != nil {
				t.Fatalf("ordinary node card could not be answered: %v", err)
			}
			answerTimer := time.NewTimer(5 * time.Second)
			defer answerTimer.Stop()
			select {
			case answer := <-done:
				if answer.err != nil || answer.resolution.Allow == nil || !*answer.resolution.Allow {
					t.Fatalf("node answer = %+v, %v", answer.resolution, answer.err)
				}
			case <-answerTimer.C:
				t.Fatal("ordinary node card answer deadlocked")
			}
			e.f.mu.Lock()
			e.f.onTell = nil
			e.f.mu.Unlock()
		})
	}
}

func TestAssistantSideCardStaysAnswerableByOwner(t *testing.T) {
	s, f := newOwnerPushSourceService(t)
	pushQuietFor(t, s, true)
	ownerTranscript(f, false)
	ix := askUserSourceCard(t, s, "side1", askUserSourceArgs("", ""))
	published := make(chan struct{}, 16)
	f.mu.Lock()
	f.onTell = func() {
		select {
		case published <- struct{}{}:
		default:
		}
	}
	f.mu.Unlock()
	s.askOnPhone([]proto.Interaction{ix})
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		stored, ok := s.pendingIx(ix.ID)
		if ok && stored.PushLevel == assistantwire.LevelP1 {
			ix = stored
			break
		}
		select {
		case <-published:
		case <-timer.C:
			t.Fatal("assistant side card was not announced")
		}
	}
	if ix.PushLevel != assistantwire.LevelP1 || ix.Delegating {
		t.Fatalf("assistant side card = %+v, want a direct held P1", ix)
	}
	if hasRelayFrom(s, "conv1", cardAskUser, "interaction_id="+ix.ID) {
		t.Fatal("assistant side card was routed to main, which is forbidden to answer it")
	}
	if _, ok := s.routedTo(ix.ID, "conv1", true); ok {
		t.Fatal("assistant side card acquired an answerable main route")
	}
	_, told := s.pendingCards()
	if !told[ix.ID] {
		t.Fatal("assistant side card is absent from Needs you")
	}
	raw, _ := json.Marshal(proto.Resolution{Answers: map[string]string{"Which option?": "One"}})
	if _, err := s.Action(context.Background(), Action{Op: "answer", InteractionID: ix.ID, Answer: raw}); err != nil {
		t.Fatalf("owner could not answer assistant side card: %v", err)
	}
	f.mu.Lock()
	f.onTell = nil
	f.mu.Unlock()
}

func TestFirstHeldNonOwnerDoesNotBypassTerminalOnlyAboveLeader(t *testing.T) {
	e := newRouteEnv(t, nil, true)
	pushQuietFor(t, e.s, true)
	ix := nonOwnerCardFixture(cardAgentPermission)
	ix.SessionID = "worker-1"
	e.hold(ix)
	if !e.s.handNonOwnerCard(ix) {
		t.Fatal("failed to construct the first held non-owner route")
	}
	if got := e.s.waitingCards(e.todo, true, false); len(got) != 0 {
		t.Fatalf("above-leader terminal-only filter admitted permission cards: %v", got)
	}
}

func TestManagerClassifiedP0RequiresSameCardGeneration(t *testing.T) {
	e := newRouteEnv(t, nil, true)
	ix := nonOwnerCardFixture(cardAgentPermission)
	ix.PushLevel = assistantwire.LevelP0
	e.hold(ix)
	e.s.questions.mu.Lock()
	e.s.questions.m = map[string]*question{ix.ID: {ix: ix}}
	e.s.questions.mu.Unlock()
	if !e.s.managerClassifiedP0(ix) {
		t.Fatal("the manager-owned pending generation was not recognized")
	}
	reusedID := ix
	reusedID.CreatedAt = ix.CreatedAt.Add(time.Second)
	if e.s.managerClassifiedP0(reusedID) {
		t.Fatal("a different external card inherited manager P0 by reusing its ID")
	}
}

func TestCodexNodeCardsUseManagerPushProvenance(t *testing.T) {
	for _, mode := range []string{"quiet", "grading"} {
		for _, tc := range []struct {
			name    string
			ownerP1 bool
		}{
			{name: "ordinary self P0 becomes held P1"},
			{name: "owner-only explicit P1 is not upgraded", ownerP1: true},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				answered := make(chan map[string]any, 1)
				e.d.mu.Lock()
				e.d.machines["mac"].call = func(method string, params json.RawMessage) (any, error) {
					if method == "codex.answer" {
						var p map[string]any
						_ = json.Unmarshal(params, &p)
						answered <- p
						return map[string]any{"ok": true}, nil
					}
					return map[string]any{}, nil
				}
				e.d.mu.Unlock()
				ix := nonOwnerCardFixture(cardAgentPermission)
				ix.ID = "ix_codex_self_p0_" + mode
				ix.PushLevel = assistantwire.LevelP0
				if tc.ownerP1 {
					ix = ownerCardFixture(cardDeviceControl)
					ix.ID = "ix_codex_explicit_p1_" + mode
					ix.PushLevel = assistantwire.LevelP1
				}
				pushes := captureCardPushes(e)
				if mode == "quiet" {
					pushQuietFor(t, e.s, true)
				} else {
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
				}
				listCodex(e.s, ix) // direct codex.interactions inventory: it never passes nodeInteraction.
				stored, ok := e.s.pendingIx(ix.ID)
				if !ok {
					t.Fatal("Codex card disappeared")
				}
				n := cardPushFor(t, pushes, ix.ID)
				if tc.ownerP1 {
					if stored.PushLevel != assistantwire.LevelP1 || stored.Delegating {
						t.Fatalf("explicit owner P1 was rewritten: %+v", stored)
					}
					_, told := e.s.pendingCards()
					if !told[ix.ID] {
						t.Fatal("owner-only Codex card is absent from Needs you")
					}
					if hasRelayFrom(e.s, "conv1", cardDeviceControl, "interaction_id="+ix.ID) {
						t.Fatal("owner-only Codex card took the non-owner route")
					}
					if n.Interaction == nil || n.Interaction.PushLevel != assistantwire.LevelP1 || n.Level == assistantwire.LevelP0 {
						t.Fatalf("explicit P1 was upgraded to an alert: %+v", n)
					}
				} else {
					if stored.PushLevel != assistantwire.LevelP1 || stored.Delegating {
						t.Fatalf("Codex self-declared P0 survived: %+v", stored)
					}
					if _, ok := e.s.routedTo(ix.ID, "conv1", false); !ok {
						t.Fatal("held Codex card cannot be answered through its route")
					}
					if n.Level != assistantwire.LevelP1 || n.Interaction == nil || n.Interaction.PushLevel != assistantwire.LevelP1 {
						t.Fatalf("Codex self-declared P0 push = %+v, want held P1", n)
					}
				}
				allow := true
				if err := e.s.resolve(ix.ID, proto.Resolution{Allow: &allow}); err != nil {
					t.Fatalf("Codex card could not be answered: %v", err)
				}
				timer := time.NewTimer(5 * time.Second)
				defer timer.Stop()
				select {
				case answer := <-answered:
					if answer["id"] != ix.ID {
						t.Fatalf("Codex answer = %+v, want id %s", answer, ix.ID)
					}
				case <-timer.C:
					t.Fatal("Codex answer did not reach the node")
				}
			})
		}
	}
}
