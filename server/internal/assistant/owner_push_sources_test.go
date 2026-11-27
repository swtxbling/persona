package assistant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/assistantwire"
	"github.com/nwverse/persona/server/internal/prompts"
	"github.com/nwverse/persona/server/internal/proto"
)

func newOwnerPushSourceService(t *testing.T) (*Service, *fakeHub) {
	t.Helper()
	return newOwnerPushSourceServiceOn(t, false)
}

func newOwnerPushSourceServiceOn(t *testing.T, plans bool) (*Service, *fakeHub) {
	t.Helper()
	f := newFakeHub().withMachine()
	f.sessions["box"] = nil
	f.known["conv1"], f.known["side1"] = true, true
	f.setSessions("server",
		proto.Session{SessionID: "conv1", MachineID: "server", Assistant: true, Status: proto.StatusIdle},
		proto.Session{SessionID: "side1", MachineID: "server", Assistant: true, Status: proto.StatusIdle})
	var s *Service
	if plans {
		s = storelessService(t, f)
	} else {
		s = newTestService(t, f)
	}
	setSettings(t, s, func(v *Settings) { v.Main, v.MachineID = "conv1", "server" })
	return s, f
}

func ownerTranscript(f *fakeHub, background bool) {
	item := proto.Item{Role: "user", Kind: proto.KindText, Text: "Please check this", TS: time.Now()}
	if background {
		item.Source = &proto.MessageSource{Kind: proto.SourcePatrol, Title: "Nightly review"}
	}
	f.setItems(item)
}

func callOwnerSourceTool(t *testing.T, s *Service, session, name string, args map[string]any) proto.ToolResult {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return s.Tool(context.Background(), ToolCall{Name: name, Arguments: raw, MachineID: "server", SessionID: session})
}

func TestNotifyUserOwnerPushLevelAtSource(t *testing.T) {
	for _, tc := range []struct {
		name       string
		quiet      bool
		session    string
		background bool
		level      string
		why        string
		want       string
	}{
		{name: "quiet main ordinary self P0", quiet: true, session: "conv1", level: assistantwire.LevelP0, want: assistantwire.LevelP1},
		{name: "quiet main declared owner reason", quiet: true, session: "conv1", level: assistantwire.LevelP0, why: whyOnlyOwnerKnow, want: assistantwire.LevelP0},
		{name: "quiet main declared priority", quiet: true, session: "conv1", level: assistantwire.LevelP0, why: whyPriority, want: assistantwire.LevelP1},
		{name: "quiet main reason without P0 request", quiet: true, session: "conv1", why: whyOnlyOwnerKnow, want: assistantwire.LevelP1},
		{name: "quiet background cannot self P0", quiet: true, session: "conv1", background: true, level: assistantwire.LevelP0, why: whyOnlyOwnerKnow, want: assistantwire.LevelP1},
		{name: "quiet non main cannot self P0", quiet: true, session: "side1", level: assistantwire.LevelP0, why: whyOnlyOwnerKnow, want: assistantwire.LevelP1},
		{name: "quiet explicit P1", quiet: true, session: "conv1", level: assistantwire.LevelP1, why: whyOnlyOwnerKnow, want: assistantwire.LevelP1},
		{name: "off keeps explicit P0", session: "conv1", background: true, level: assistantwire.LevelP0, want: assistantwire.LevelP0},
		{name: "off keeps derived default", session: "side1", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newOwnerPushSourceService(t)
			pushQuietFor(t, s, tc.quiet)
			ownerTranscript(f, tc.background)
			args := map[string]any{"title": "Result", "body": "Read the result"}
			if tc.level != "" {
				args["push_level"] = tc.level
			}
			if tc.why != "" {
				args["why_owner"] = tc.why
			}
			if res := callOwnerSourceTool(t, s, tc.session, "notify_user", args); res.IsError {
				t.Fatalf("notify_user: %+v", res)
			}
			pushes := f.pushed()
			if len(pushes) != 1 || pushes[0].Level != tc.want {
				t.Fatalf("pushes = %+v, want one level %q", pushes, tc.want)
			}
		})
	}
}

func TestNotifyUserRejectsUnknownOwnerReason(t *testing.T) {
	s, f := newOwnerPushSourceService(t)
	pushQuietFor(t, s, true)
	ownerTranscript(f, false)
	res := callOwnerSourceTool(t, s, "conv1", "notify_user", map[string]any{
		"title": "Result", "body": "Read the result", "push_level": assistantwire.LevelP0, "why_owner": "urgent",
	})
	if !res.IsError || !strings.Contains(res.Content[0].Text, "why_owner") {
		t.Fatalf("unknown why_owner = %+v", res)
	}
	if got := f.pushed(); len(got) != 0 {
		t.Fatalf("invalid reason pushed: %+v", got)
	}
}

func askUserSourceCard(t *testing.T, s *Service, session string, args map[string]any) proto.Interaction {
	t.Helper()
	args["wait"] = false
	res := callOwnerSourceTool(t, s, session, "ask_user", args)
	if res.IsError {
		t.Fatalf("ask_user: %+v", res)
	}
	cards := s.pendingQuestions()
	if len(cards) != 1 {
		t.Fatalf("pending cards = %+v, want one", cards)
	}
	return cards[0]
}

func askUserSourceArgs(level, why string) map[string]any {
	args := map[string]any{"questions": []map[string]any{{
		"question": "Which option?", "options": []map[string]any{{"label": "One"}, {"label": "Two"}},
	}}}
	if level != "" {
		args["push_level"] = level
	}
	if why != "" {
		args["why_owner"] = why
	}
	return args
}

func TestAskUserOwnerPushLevelAtSource(t *testing.T) {
	for _, tc := range []struct {
		name       string
		quiet      bool
		session    string
		background bool
		level      string
		why        string
		want       string
	}{
		{name: "quiet main ordinary self P0", quiet: true, session: "conv1", level: assistantwire.LevelP0, want: assistantwire.LevelP1},
		{name: "quiet main declared owner reason", quiet: true, session: "conv1", level: assistantwire.LevelP0, why: whyOnlyOwnerKnow, want: assistantwire.LevelP0},
		{name: "quiet non main declared owner reason", quiet: true, session: "side1", level: assistantwire.LevelP0, why: whyOnlyOwnerKnow, want: assistantwire.LevelP0},
		{name: "quiet background ordinary self P0", quiet: true, session: "conv1", background: true, level: assistantwire.LevelP0, want: assistantwire.LevelP1},
		{name: "quiet background declared owner reason", quiet: true, session: "conv1", background: true, level: assistantwire.LevelP0, why: whyIrreversible, want: assistantwire.LevelP0},
		{name: "quiet declared priority", quiet: true, session: "conv1", level: assistantwire.LevelP0, why: whyPriority, want: assistantwire.LevelP1},
		{name: "quiet explicit P1 wins", quiet: true, session: "conv1", level: assistantwire.LevelP1, why: whyOnlyOwnerKnow, want: assistantwire.LevelP1},
		{name: "quiet declared reason needs no self P0", quiet: true, session: "conv1", why: whyVisible, want: assistantwire.LevelP0},
		{name: "off keeps old default", session: "conv1", want: ""},
		{name: "off carries explicit P0", session: "side1", level: assistantwire.LevelP0, want: assistantwire.LevelP0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newOwnerPushSourceService(t)
			pushQuietFor(t, s, tc.quiet)
			ownerTranscript(f, tc.background)
			ix := askUserSourceCard(t, s, tc.session, askUserSourceArgs(tc.level, tc.why))
			if ix.PushLevel != tc.want {
				t.Fatalf("card push_level = %q, want %q (%+v)", ix.PushLevel, tc.want, ix)
			}
			var input map[string]any
			if err := json.Unmarshal(ix.ToolInput, &input); err != nil {
				t.Fatal(err)
			}
			if got, _ := input["why_owner"].(string); got != tc.why {
				t.Fatalf("card why_owner = %q, want %q", got, tc.why)
			}
		})
	}
}

func TestAskUserValidatesOwnerPushArguments(t *testing.T) {
	for _, tc := range []struct {
		name  string
		level string
		why   string
		want  string
	}{
		{name: "unknown owner reason", level: assistantwire.LevelP0, why: "urgent", want: "why_owner"},
		{name: "unknown push level", level: "P9", why: whyOnlyOwnerKnow, want: "push_level"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newOwnerPushSourceService(t)
			pushQuietFor(t, s, true)
			ownerTranscript(f, false)
			args := askUserSourceArgs(tc.level, tc.why)
			args["wait"] = false
			res := callOwnerSourceTool(t, s, "conv1", "ask_user", args)
			if !res.IsError || !strings.Contains(res.Content[0].Text, tc.want) {
				t.Fatalf("result = %+v, want %s error", res, tc.want)
			}
			if got := s.pendingQuestions(); len(got) != 0 {
				t.Fatalf("invalid arguments raised a card: %+v", got)
			}
		})
	}
}

func TestPlanWaitingPushLevelAtSource(t *testing.T) {
	for _, tc := range []struct {
		name    string
		quiet   bool
		session string
		step    string
		want    string
		wantKey bool
	}{
		{name: "quiet main without owner step", quiet: true, session: "conv1", want: assistantwire.LevelP1, wantKey: true},
		{name: "quiet side without owner step", quiet: true, session: "side1", want: assistantwire.LevelP1, wantKey: true},
		{name: "quiet money owner step", quiet: true, session: "conv1", step: ownerStepMoney, want: assistantwire.LevelP0, wantKey: true},
		{name: "quiet outward owner step", quiet: true, session: "side1", step: ownerStepOutward, want: assistantwire.LevelP0, wantKey: true},
		{name: "quiet irreversible owner step", quiet: true, session: "conv1", step: ownerStepIrreversible, want: assistantwire.LevelP0, wantKey: true},
		{name: "off keeps old default", session: "conv1", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newOwnerPushSourceServiceOn(t, true)
			pushQuietFor(t, s, tc.quiet)
			if tc.step != "" {
				s.mainPlansWait = false
			}
			args := planArgs(false)
			if tc.step != "" {
				args = planArgsWithStep(t, tc.step)
			}
			out, err := s.toolTaskPlan(context.Background(), tc.session, args)
			if err != nil || !strings.Contains(out, "needs the user's Start") {
				t.Fatalf("task_plan = %q, %v", out, err)
			}
			pushes := f.pushed()
			if len(pushes) != 1 || pushes[0].Level != tc.want {
				t.Fatalf("pushes = %+v, want one level %q", pushes, tc.want)
			}
			wantKey := ""
			if tc.wantKey {
				wantKey = "plan:" + pushes[0].CardID
			}
			if pushes[0].RelatedKey != wantKey {
				t.Fatalf("related_key = %q, want %q", pushes[0].RelatedKey, wantKey)
			}
		})
	}
}

func settingSourceCard(t *testing.T, s *Service, f *fakeHub, key, value string) proto.Interaction {
	t.Helper()
	setting, found, err := s.lookupManagedOwnSetting(context.Background(), key)
	if err != nil || !found {
		t.Fatalf("lookup %s: found=%v err=%v", key, found, err)
	}
	published := make(chan struct{}, 16)
	f.mu.Lock()
	f.onTell = func() {
		select {
		case published <- struct{}{}:
		default:
		}
	}
	f.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := s.ownSettingAction(ctx, ToolCall{MachineID: "server", SessionID: "conv1"}, setting, "set", json.RawMessage(value))
		done <- err
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var card proto.Interaction
	for {
		if cards := s.pendingQuestions(); len(cards) == 1 {
			card = cards[0]
			break
		}
		select {
		case <-published:
		case <-timer.C:
			t.Fatal("setting approval card was not published")
		}
	}
	allow := false
	raw, _ := json.Marshal(proto.Resolution{Allow: &allow})
	if _, err := s.Action(context.Background(), Action{Op: "answer", InteractionID: card.ID, Answer: raw}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-timer.C:
		t.Fatal("setting approval did not finish")
	}
	f.mu.Lock()
	f.onTell = nil
	f.mu.Unlock()
	return card
}

func TestSettingsChangePushLevelAtSource(t *testing.T) {
	for _, tc := range []struct {
		name  string
		quiet bool
		key   string
		value string
		want  string
	}{
		{name: "quiet security boundary", quiet: true, key: readonlyModeKey, value: `"prompt"`, want: assistantwire.LevelP0},
		{name: "quiet reversible operation", quiet: true, key: "assistant.recent_task_chats", value: `true`, want: assistantwire.LevelP1},
		{name: "off keeps old default", key: "assistant.recent_task_chats", value: `true`, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newOwnerPushSourceService(t)
			pushQuietFor(t, s, tc.quiet)
			card := settingSourceCard(t, s, f, tc.key, tc.value)
			if card.PushLevel != tc.want {
				t.Fatalf("settings card push_level = %q, want %q (%+v)", card.PushLevel, tc.want, card)
			}
			if tc.key == "assistant.recent_task_chats" && s.recentTaskChats(context.Background()) {
				t.Fatal("a reversible operational setting executed without owner approval")
			}
		})
	}
}

type ownerPushCaptureHub struct {
	*fakeHub
	seen chan Notification
}

func (h *ownerPushCaptureHub) NotifyRequest(ctx context.Context, p NotifyRequest) (NotifyResult, error) {
	res, err := h.fakeHub.NotifyRequest(ctx, p)
	h.seen <- p.Notification
	return res, err
}

func newOwnerPushCaptureService(t *testing.T) (*Service, *fakeHub, <-chan Notification) {
	t.Helper()
	f := newFakeHub().withMachine()
	f.known["conv1"], f.known["side1"] = true, true
	f.setSessions("server", proto.Session{SessionID: "conv1", MachineID: "server", Assistant: true, Status: proto.StatusIdle})
	h := &ownerPushCaptureHub{fakeHub: f, seen: make(chan Notification, 4)}
	st := &memStore{}
	s := withSettings(t, f, New(Options{Hub: h, Store: func() Store { return st }, Logf: testLogf(t)}))
	setSettings(t, s, func(v *Settings) { v.Main, v.MachineID = "conv1", "server" })
	return s, f, h.seen
}

func nextOwnerPush(t *testing.T, seen <-chan Notification) Notification {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case n := <-seen:
		return n
	case <-timer.C:
		t.Fatal("card push was not delivered to the hub")
		return Notification{}
	}
}

func TestAskUserP0CardCanBeAnsweredWithoutWaitingBypass(t *testing.T) {
	s, f, seen := newOwnerPushCaptureService(t)
	pushQuietFor(t, s, true)
	ownerTranscript(f, false)
	published := make(chan struct{}, 16)
	f.mu.Lock()
	f.onTell = func() {
		select {
		case published <- struct{}{}:
		default:
		}
	}
	f.mu.Unlock()
	done := make(chan proto.ToolResult, 1)
	go func() {
		done <- callOwnerSourceTool(t, s, "conv1", "ask_user", askUserSourceArgs(assistantwire.LevelP0, whyOnlyOwnerKnow))
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var ix proto.Interaction
	for {
		if cards := s.pendingQuestions(); len(cards) == 1 {
			ix = cards[0]
			break
		}
		select {
		case <-published:
		case <-timer.C:
			t.Fatal("waiting ask_user card was not published")
		}
	}
	s.askOnPhone([]proto.Interaction{ix})
	n := nextOwnerPush(t, seen)
	if n.Interaction == nil || n.Interaction.PushLevel != assistantwire.LevelP0 {
		t.Fatalf("push = %+v, want the declared P0 card", n)
	}
	raw, _ := json.Marshal(proto.Resolution{Answers: map[string]string{"Which option?": "One"}})
	if _, err := s.Action(context.Background(), Action{Op: "answer", InteractionID: ix.ID, Answer: raw}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		if res.IsError || !strings.Contains(res.Content[0].Text, "Which option? → One") {
			t.Fatalf("ask_user answer = %+v", res)
		}
	case <-timer.C:
		t.Fatal("declared P0 ask_user did not return its answer")
	}
	f.mu.Lock()
	f.onTell = nil
	f.mu.Unlock()
}

func TestOwnerCardsCarryTheirLevelIntoThePush(t *testing.T) {
	t.Run("ask_user", func(t *testing.T) {
		s, f, seen := newOwnerPushCaptureService(t)
		pushQuietFor(t, s, true)
		ownerTranscript(f, false)
		ix := askUserSourceCard(t, s, "conv1", askUserSourceArgs(assistantwire.LevelP0, ""))
		s.askOnPhone([]proto.Interaction{ix})
		n := nextOwnerPush(t, seen)
		if n.Interaction == nil || n.Interaction.ID != ix.ID || n.Interaction.PushLevel != assistantwire.LevelP1 {
			t.Fatalf("push = %+v, want the ask_user card at P1", n)
		}
		raw, _ := json.Marshal(proto.Resolution{Dismiss: true})
		if _, err := s.Action(context.Background(), Action{Op: "answer", InteractionID: ix.ID, Answer: raw}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("settings_change", func(t *testing.T) {
		s, f, seen := newOwnerPushCaptureService(t)
		pushQuietFor(t, s, true)
		ix := settingSourceCard(t, s, f, "assistant.recent_task_chats", `true`)
		n := nextOwnerPush(t, seen)
		if n.Interaction == nil || n.Interaction.ID != ix.ID || n.Interaction.PushLevel != assistantwire.LevelP1 {
			t.Fatalf("push = %+v, want the settings card at P1", n)
		}
	})
}

func TestOwnerPushToolSchemasDeclareReasonAndLevel(t *testing.T) {
	for _, name := range []string{"ask_user", "notify_user"} {
		tool := prompts.Tool(name)
		var schema struct {
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"push_level", "why_owner"} {
			raw, ok := schema.Properties[field]
			if !ok {
				t.Errorf("%s schema has no %s: %s", name, field, tool.InputSchema)
				continue
			}
			if field == "why_owner" {
				for _, why := range whyOwners {
					if !strings.Contains(string(raw), `"`+why+`"`) {
						t.Errorf("%s why_owner schema omits %q: %s", name, why, raw)
					}
				}
			}
		}
	}
}
