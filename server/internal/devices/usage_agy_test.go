package devices

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/tokenuse"
)

// End-to-end hub aggregation for Antigravity (agy): real-time TPM (2-3 min sliding output window), machine card
// per_minute / today / sparkline, daily & hourly agent breakdowns, and per-launcher filtering.
func TestUsageAgyRealtimeTPMAndTodaySummary(t *testing.T) {
	loc := time.FixedZone("test", 8*3600)
	now := time.Date(2026, 11, 27, 10, 5, 30, 0, loc) // 2.5 min window from 10:03:00 to 10:05:30
	minute := now.Unix() / 60 * 60

	d := New(Options{Hub: &fakeHost{}, Store: newMemStore(), Location: func() *time.Location { return loc }})
	payload, err := json.Marshal(map[string]any{
		"full":      true,
		"launchers": true,
		"load":      2.0,
		"cpus":      4,
		"buckets": []proto.UsageBucket{
			// Supervisor / direction session active in current minute.
			{Minute: minute, Model: "gemini-4-neon-high", Launcher: "agy-track", Agent: "agy",
				Input: 4000, CacheRead: 12000, CacheWrite: 500, Output: 500, Requests: 2},
			// Development Agent session active 1 minute ago.
			{Minute: minute - 60, Model: "claude-opus-5-5-high", Launcher: "agy", Agent: "agy",
				Input: 2000, CacheRead: 8000, Output: 1000, Requests: 3},
			// Earlier today (2 hours ago): counts in today/history, excluded from 2-3 min TPM window.
			{Minute: minute - 2*3600, Model: "gemini-4-neon-high", Launcher: "agy-track", Agent: "agy",
				Input: 1000, Output: 250, Requests: 1},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.onUsage("box-a", payload, now)

	// 1. Fleet UsageSummary (Live Activity / Island TPM + today totals):
	// Recent output = 500 + 1000 = 1500 over 2.5 minutes => TPM = 600.
	sum := d.usage.summary(now, loc)
	if sum.TPM != 600 || sum.Output != 1750 || sum.Requests != 6 || sum.Tokens != 29250 {
		t.Fatalf("summary = %+v, want TPM=600 Output=1750 Requests=6 Tokens=29250", sum)
	}
	if len(sum.Machines) != 1 || sum.Machines[0].ID != "box-a" || sum.Machines[0].TPM != 600 || sum.Machines[0].Tokens != 29250 {
		t.Fatalf("summary machines = %+v", sum.Machines)
	}

	// 2. Machine card (GET /api/v1/metrics):
	// Recent total tokens = (4000+12000+500+500) + (2000+8000+1000) = 28000 over 2.5 min => 11200/min.
	card := d.usage.card("box-a", now, loc)
	if card == nil || card.PerMinute != 11200 || card.Today.Total() != 29250 || card.Today.Output != 1750 || card.Today.Requests != 6 {
		t.Fatalf("card = %+v", card)
	}
	if len(card.Recent) != 60 || card.Recent[59] != 17000 || card.Recent[58] != 11000 {
		t.Fatalf("card sparkline tail = %v %v", card.Recent[58], card.Recent[59])
	}

	// 3. Daily summary (GET /api/v1/usage/days):
	days, err := d.usageDays(context.Background(), 1, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(days.Days) != 1 || days.Days[0].Total() != 29250 || days.Days[0].Output != 1750 || days.Days[0].Requests != 6 {
		t.Fatalf("days = %+v", days.Days)
	}

	// 4. Hourly agent breakdown includes agy.
	hours, err := d.usageHours(context.Background(), 1, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(hours.Agents) != 1 || hours.Agents[0].Agent != "agy" || hours.Agents[0].Output != 1750 {
		t.Fatalf("hours agents = %+v", hours.Agents)
	}

	// 5. Launcher filter splits supervisor/direction launcher from regular agy sessions.
	rows := d.usage.buckets("box-a")
	from := now.Add(-24 * time.Hour).Truncate(10 * time.Minute).Add(10 * time.Minute)
	_, trackTotal, _, launchers := usageSeries(rows, from, now, 600, usageFilter{launcher: strp("agy-track")}, nil)
	if trackTotal.Total() != 18250 || trackTotal.Output != 750 || trackTotal.Requests != 3 || len(launchers) != 2 {
		t.Fatalf("agy-track series = %+v launchers=%+v", trackTotal, launchers)
	}
}

// Reconnect & rolling-upgrade idempotency for agy:
//   - Incremental updates overwrite the minute's bucket (monotonic TPM, never additive double-count).
//   - Reconnect full:true replaces file-metered agy and claude buckets cleanly (zero 2x) while preserving runtime-only
//     agents (e.g. grok) that use add:true.
func TestUsageAgyReconnectFullReplacesWithoutDoubleCount(t *testing.T) {
	if !tokenuse.FileMetered("agy") {
		t.Fatal("agy must be file-metered on manager")
	}
	loc := time.UTC
	now := time.Date(2026, 11, 27, 10, 5, 30, 0, loc)
	minute := now.Unix() / 60 * 60

	s := &runtimeUsageStore{usageMemStore: &usageMemStore{memStore: newMemStore(), done: make(chan struct{}, 16)}}
	d := New(Options{Hub: &fakeHost{}, Store: &runtimeUsageBatchStore{s}, Location: func() *time.Location { return loc }})

	send := func(add, full bool, bs ...proto.UsageBucket) {
		p, err := json.Marshal(map[string]any{"add": add, "full": full, "launchers": true, "buckets": bs})
		if err != nil {
			t.Fatal(err)
		}
		d.onUsage("box", p, now)
	}
	b := func(agent string, out int64, req int) proto.UsageBucket {
		return proto.UsageBucket{Minute: minute, Model: "gemini-4-neon-high", Launcher: agent, Agent: agent, Output: out, Requests: req}
	}

	// Initial full report + a separate runtime-only agent delta.
	send(false, true, b("agy", 250, 1), b("claude", 100, 1))
	send(true, false, b("grok", 50, 1))
	if sum := d.usage.summary(now, loc); sum.Output != 400 || sum.TPM != 160 {
		t.Fatalf("initial summary = %+v, want Output=400 TPM=160", sum)
	}

	// Streaming incremental update on the same minute (output grew 250 -> 500): overwrites, never adds to 750.
	send(false, false, b("agy", 500, 1))
	if sum := d.usage.summary(now, loc); sum.Output != 650 || sum.TPM != 260 {
		t.Fatalf("after incremental update = %+v, want Output=650 TPM=260", sum)
	}

	// Node reconnects and sends a fresh full:true report with the exact same file-metered buckets.
	// agy and claude are replaced (zero 2x double-count), while runtime-only grok survives.
	send(false, true, b("agy", 500, 1), b("claude", 100, 1))
	if sum := d.usage.summary(now, loc); sum.Output != 650 || sum.TPM != 260 || sum.Requests != 3 {
		t.Fatalf("after reconnect full:true = %+v, want Output=650 TPM=260 Requests=3", sum)
	}

	// A second reconnect where agy dropped out of the window replaces agy to 0 while grok still survives.
	send(false, true, b("claude", 100, 1))
	if sum := d.usage.summary(now, loc); sum.Output != 150 || sum.Requests != 2 {
		t.Fatalf("after agy left window = %+v, want claude(100)+grok(50)=150", sum)
	}
}
