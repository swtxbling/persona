package assistant

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/assistantwire"
	"github.com/nwverse/persona/server/internal/proto"
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

func TestNonOwnerCardSourcesRouteAndGradeDeterministically(t *testing.T) {
	sources := []string{cardAgentPermission, cardAgentQuestion, cardToolPermission, cardDeviceControl}
	for _, source := range sources {
		for _, mode := range []string{"off", "quiet", "grading"} {
			t.Run(source+"/"+mode, func(t *testing.T) {
				e := newRouteEnv(t, nil, true)
				ix := nonOwnerCardFixture(source)
				prepareNonOwnerCard(e, ix, source)
				var pushes <-chan Notification
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
					pushes = captureCardPushes(e)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
					pushes = captureCardPushes(e)
				}
				e.s.announce(ix)
				checkNonOwnerRoute(t, e, ix, source, mode != "off")
				if mode != "off" {
					n := cardPushFor(t, pushes, ix.ID)
					if n.Kind != assistantwire.NotifyInput || n.Level != assistantwire.LevelP1 || n.Interaction.PushLevel != assistantwire.LevelP1 {
						t.Fatalf("%s push = kind %q, level %q, card level %q; want an explicit held P1", source, n.Kind, n.Level, n.Interaction.PushLevel)
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
				var pushes <-chan Notification
				switch mode {
				case "quiet":
					pushQuietFor(t, e.s, true)
					pushes = captureCardPushes(e)
				case "grading":
					pushQuietFor(t, e.s, false)
					setPushGradingCardsForTest(e.f)
					pushes = captureCardPushes(e)
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
				checkNonOwnerRoute(t, e, ix, cardAgentQuestion, mode != "off")
				if mode != "off" {
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
