package assistant

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/nwverse/persona/server/internal/prompts"
)

// noisySnapshotForBudget contains only synthetic values. Its three large collections used to make every message carry
// completed-agent rows, ordinary-chat names and complete model-tier configuration.
func noisySnapshotForBudget() prompts.Snapshot {
	now := time.Date(2026, time.November, 26, 9, 30, 0, 0, time.UTC)
	unread := make([]prompts.SnapshotAgent, 450)
	other := make([]prompts.SnapshotChat, 450)
	for i := range unread {
		unread[i] = prompts.SnapshotAgent{
			Label:   fmt.Sprintf("finished-agent-noise-%03d", i),
			Machine: "example-machine",
			Session: fmt.Sprintf("unread-%03d", i),
			Line:    strings.Repeat("finished-unread-detail-noise-", 8),
		}
		other[i] = prompts.SnapshotChat{Name: fmt.Sprintf("ordinary-group-noise-%03d", i), Unread: i + 1}
	}
	return prompts.Snapshot{
		Now:  now,
		Zone: "UTC",
		ModelProfile: &prompts.SnapshotProfile{ID: "profile-id-kept", Name: "profile-active-kept", Tiers: []prompts.SnapshotTier{
			{Name: "tier-review-kept", Launcher: "launcher-noise", Model: "candidate-model-noise", Effort: "effort-noise", Speed: "speed-noise",
				PermissionMode: "permission-noise", Description: strings.Repeat("model-description-noise-", 1000), More: 37, Aliases: []string{"model-alias-noise"}},
			{Name: "tier-build-kept", Launcher: "another-launcher-noise", Description: strings.Repeat("another-description-noise-", 1000)},
		}},
		Needs: []prompts.SnapshotAgent{{
			Label: "needs-you-kept", Machine: "example-machine", Session: "needs-1", Line: "needs-you-summary-kept",
		}},
		Awaiting: []prompts.SnapshotAgent{{
			Label: "awaiting-reply-kept", Machine: "example-machine", Session: "awaiting-1", Line: "awaiting-reply-summary-kept",
		}},
		Unread:  unread,
		Working: make([]prompts.SnapshotAgent, 3),
		Plans: []prompts.SnapshotPlan{{
			ID: "plan-kept", At: now, Titles: []string{"pending-start-kept"}, Tasks: 1,
		}},
		Chats: &prompts.SnapshotChats{
			AtMe:  []prompts.SnapshotChat{{Name: "mention-chat-kept", Unread: 2, Preview: "mention-preview-kept"}},
			Other: other,
		},
		Calendar: &prompts.SnapshotCalendar{Events: []prompts.SnapshotEvent{{
			Start: now.Add(time.Hour), End: now.Add(2 * time.Hour), Title: "calendar-kept",
		}}},
		Missed:      []prompts.SnapshotMiss{{At: now, Label: "failed-schedule-kept", Why: "failed-schedule-reason-kept"}},
		MissedTotal: 1,
	}
}

func assertSnapshotWithinBudget(t *testing.T, got string) {
	t.Helper()
	if n := utf8.RuneCountInString(got); n > snapshotBudget {
		t.Fatalf("snapshot has %d runes, budget is %d", n, snapshotBudget)
	}
	if !utf8.ValidString(got) {
		t.Fatal("snapshot is not valid UTF-8")
	}
}

func assertSnapshotEssentials(t *testing.T, got string) {
	t.Helper()
	for _, want := range []string{
		"完成未看 450 个",
		"工作中 3 个",
		"agents_list state=unread",
		"needs-you-kept",
		"needs-you-summary-kept",
		"awaiting-reply-summary-kept",
		"等用户点「开始」的计划",
		"pending-start-kept",
		"failed-schedule-kept",
		"failed-schedule-reason-kept",
		"mention-chat-kept（2 条）：mention-preview-kept",
		"其他：450 个会话",
		"lark_chats",
		"calendar-kept",
		"profile-active-kept (profile-id-kept)",
		"tier-review-kept",
		"tier-build-kept",
		"model_profiles_list",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("essential snapshot content %q is missing", want)
		}
	}
	for _, unwanted := range []string{
		"finished-agent-noise-",
		"session_id=unread-",
		"finished-unread-detail-noise-",
		"ordinary-group-noise-",
		"model-description-noise-",
		"another-description-noise-",
		"launcher-noise",
		"candidate-model-noise",
		"effort-noise",
		"speed-noise",
		"permission-noise",
		"model-alias-noise",
		"另有 37 个候选",
	} {
		if strings.Contains(got, unwanted) {
			t.Errorf("snapshot noise %q was rendered", unwanted)
		}
	}
}

func TestSnapshotBudgetDropsNoiseAndKeepsEssentials(t *testing.T) {
	snap := noisySnapshotForBudget()
	for _, tc := range []struct {
		name   string
		render func(prompts.Snapshot) string
	}{
		{name: "render", render: prompts.RenderSnapshot},
		{name: "fit", render: fitSnapshot},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.render(snap)
			assertSnapshotWithinBudget(t, got)
			assertSnapshotEssentials(t, got)
		})
	}
}

func TestSnapshotBudgetEmptyAndOverlong(t *testing.T) {
	now := time.Date(2026, time.November, 26, 9, 30, 0, 0, time.UTC)
	t.Run("empty", func(t *testing.T) {
		got := fitSnapshot(prompts.Snapshot{
			Now: now, Zone: "UTC", NoPhone: true, Chats: &prompts.SnapshotChats{}, Calendar: &prompts.SnapshotCalendar{},
		})
		assertSnapshotWithinBudget(t, got)
		for _, want := range []string{"完成未看 0 个", "飞书：没有未读", "飞书日历：今天接下来没有会了"} {
			if !strings.Contains(got, want) {
				t.Errorf("empty snapshot is missing %q", want)
			}
		}
	})

	t.Run("overlong omissible sections", func(t *testing.T) {
		snap := noisySnapshotForBudget()
		snap.KB = strings.Repeat("knowledge-overflow-noise-", 2000)
		snap.Tasks = []prompts.SnapshotTask{{
			ID: "todo_overflow", Title: "task-overflow-noise", State: "working", Last: strings.Repeat("task-overflow-detail-noise-", 2000),
		}}
		got := fitSnapshot(snap)
		assertSnapshotWithinBudget(t, got)
		assertSnapshotEssentials(t, got)
		if strings.Contains(got, strings.TrimSpace(prompts.SnapshotCut())) {
			t.Fatal("omitting oversized optional sections should avoid a hard cut")
		}
	})

	t.Run("hard cut", func(t *testing.T) {
		got := fitSnapshot(prompts.Snapshot{
			Now: now, Zone: "UTC", Needs: []prompts.SnapshotAgent{{
				Label: "needs-you-cut-kept", Machine: "example-machine", Session: "needs-cut", Line: strings.Repeat("等待决定", snapshotBudget),
			}},
		})
		assertSnapshotWithinBudget(t, got)
		if !strings.Contains(got, "needs-you-cut-kept") {
			t.Fatal("hard cut lost the first needs-you agent")
		}
		if !strings.HasSuffix(got, "\n"+prompts.SnapshotCut()) {
			t.Fatal("overlong protected content does not end with the cut notice")
		}
	})
}

func TestSnapshotBudgetConcurrentCalls(t *testing.T) {
	snap := noisySnapshotForBudget()
	unchanged := noisySnapshotForBudget()
	want := fitSnapshot(snap)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 25 {
				if got := fitSnapshot(snap); got != want {
					errs <- fmt.Errorf("concurrent fit changed the snapshot output")
					return
				}
				if got := prompts.RenderSnapshot(snap); utf8.RuneCountInString(got) > snapshotBudget {
					errs <- fmt.Errorf("concurrent render exceeded %d runes", snapshotBudget)
					return
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if !reflect.DeepEqual(snap, unchanged) {
		t.Fatal("rendering or fitting mutated the shared snapshot")
	}
}
