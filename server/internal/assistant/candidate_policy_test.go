package assistant

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
)

// policyDevices wraps fleetDevs with thread-safe UsageAccounts updates for deterministic policy tests.
type policyDevices struct {
	*fleetDevs
	accMu    sync.RWMutex
	accounts []proto.UsageAccount
}

func newPolicyDevices(accounts ...proto.UsageAccount) *policyDevices {
	return &policyDevices{fleetDevs: &fleetDevs{}, accounts: append([]proto.UsageAccount(nil), accounts...)}
}

func (d *policyDevices) UsageAccounts(context.Context) []proto.UsageAccount {
	d.accMu.RLock()
	defer d.accMu.RUnlock()
	return append([]proto.UsageAccount(nil), d.accounts...)
}

func (d *policyDevices) setAccounts(accounts []proto.UsageAccount) {
	d.accMu.Lock()
	defer d.accMu.Unlock()
	d.accounts = append([]proto.UsageAccount(nil), accounts...)
}

// TestHeadroomPolicyOrderedVsPace verifies that default pace headroom is unchanged while ordered policy judges each
// applicable window by remaining allowance above reserve (15% short, 10% long) rather than linear time pace.
func TestHeadroomPolicyOrderedVsPace(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	short := func(elapsed time.Duration, used float64) proto.UsageWindow {
		return paceAt(now, "5h", 300, elapsed, used, "")
	}
	long := func(elapsed time.Duration, used float64) proto.UsageWindow {
		return paceAt(now, "7d", 10080, elapsed, used, "")
	}
	group := func(elapsed time.Duration, used float64) proto.UsageWindow {
		return paceAt(now, "7d", 10080, elapsed, used, "Alpha and Beta models")
	}
	acct := func(id string, ws ...proto.UsageWindow) proto.UsageAccount {
		return proto.UsageAccount{ID: id, Provider: "antigravity", Windows: ws, SampledAt: now}
	}
	reset5h := now.Add(4 * time.Hour)
	reset7d := now.Add(6 * 24 * time.Hour)
	past := now.Add(-time.Minute)

	// Negative weekly linear pace (1d into 7d, 55% used, 45% left) + healthy 5h window (10% used).
	aheadOfWeeklyPace := []proto.UsageAccount{acct("a", short(time.Hour, 10), long(24*time.Hour, 55))}
	paceH := headroomOfPolicy(aheadOfWeeklyPace, "antigravity", "", candidatePolicyPace, now)
	if !paceH.Known || paceH.H != 0 || paceH.RecoversAt == nil {
		t.Fatalf("default pace mode must still report H=0 when ahead of weekly pace: %+v", paceH)
	}
	orderedH := headroomOfPolicy(aheadOfWeeklyPace, "antigravity", "", candidatePolicyOrdered, now)
	if !orderedH.Known || math.Abs(orderedH.H-0.35) > 1e-9 || math.Abs(orderedH.Percent-35) > 1e-7 || orderedH.RecoversAt != nil {
		t.Fatalf("ordered mode with 55%% weekly used and healthy 5h = %+v, want H=0.35 (35%%)", orderedH)
	}

	cases := []struct {
		name      string
		accounts  []proto.UsageAccount
		model     string
		known     bool
		stale     bool
		h         float64
		recovers  *time.Time
		nAccounts int
	}{
		{
			name:      "weekly just above 10% reserve stays positive",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 10), long(24*time.Hour, 89.9))},
			known:     true,
			h:         0.001,
			nAccounts: 1,
		},
		{
			name:      "weekly at 10% reserve hits H=0 and recovers at weekly reset",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 0), long(24*time.Hour, 90))},
			known:     true,
			h:         0,
			recovers:  &reset7d,
			nAccounts: 1,
		},
		{
			name:      "weekly completely exhausted hits H=0 and recovers at weekly reset",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 0), long(24*time.Hour, 100))},
			known:     true,
			h:         0,
			recovers:  &reset7d,
			nAccounts: 1,
		},
		{
			name:      "short 5h window at 15% reserve hits H=0 despite ample weekly quota",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 85), long(24*time.Hour, 20))},
			known:     true,
			h:         0,
			recovers:  &reset5h,
			nAccounts: 1,
		},
		{
			name:      "short 5h window exhausted hits H=0 and recovers at 5h reset",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 100), long(24*time.Hour, 20))},
			known:     true,
			h:         0,
			recovers:  &reset5h,
			nAccounts: 1,
		},
		{
			name:      "both short and weekly exhausted recover at the later reset",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 95), long(24*time.Hour, 95))},
			known:     true,
			h:         0,
			recovers:  &reset7d,
			nAccounts: 1,
		},
		{
			name:      "multi-account: one exhausted and one with 35pp above reserve stays positive",
			accounts:  []proto.UsageAccount{acct("a", long(24*time.Hour, 95)), acct("b", short(time.Hour, 10), long(24*time.Hour, 55))},
			known:     true,
			h:         0.35,
			nAccounts: 2,
		},
		{
			name:      "multi-account: both exhausted recovers at the earlier reset",
			accounts:  []proto.UsageAccount{acct("a", long(24*time.Hour, 95)), acct("b", short(time.Hour, 90))},
			known:     true,
			h:         0,
			recovers:  &reset5h,
			nAccounts: 2,
		},
		{
			name: "stale account is unknown, never exhausted",
			accounts: []proto.UsageAccount{func() proto.UsageAccount {
				a := acct("a", long(24*time.Hour, 100))
				a.Stale = true
				return a
			}()},
			stale: true,
		},
		{
			name: "past stale_at is stale and unknown",
			accounts: []proto.UsageAccount{func() proto.UsageAccount {
				a := acct("a", long(24*time.Hour, 100))
				a.StaleAt = &past
				return a
			}()},
			stale: true,
		},
		{
			name:     "expired reset window is unknown",
			accounts: []proto.UsageAccount{acct("a", proto.UsageWindow{Label: "7d", WindowMinutes: 10080, UsedPercent: 100, ResetsAt: &past})},
		},
		{
			name:     "window without reset time is unknown",
			accounts: []proto.UsageAccount{acct("a", proto.UsageWindow{Label: "7d", WindowMinutes: 10080, UsedPercent: 55})},
		},
		{
			name:      "per-model window applies only to matching model",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 10), group(24*time.Hour, 95))},
			model:     "alpha-large",
			known:     true,
			h:         0,
			recovers:  &reset7d,
			nAccounts: 1,
		},
		{
			name:      "per-model window does not constrain unrelated model",
			accounts:  []proto.UsageAccount{acct("a", short(time.Hour, 10), group(24*time.Hour, 95))},
			model:     "gamma-1",
			known:     true,
			h:         0.75,
			nAccounts: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := headroomOfPolicy(tc.accounts, "antigravity", tc.model, candidatePolicyOrdered, now)
			if got.Known != tc.known || got.Stale != tc.stale || got.Accounts != tc.nAccounts {
				t.Fatalf("known/stale/accounts = %v/%v/%d, want %v/%v/%d (%+v)",
					got.Known, got.Stale, got.Accounts, tc.known, tc.stale, tc.nAccounts, got)
			}
			if math.Abs(got.H-tc.h) > 1e-9 || math.Abs(got.Percent-tc.h*100) > 1e-7 {
				t.Fatalf("H = %v (%v%%), want %v", got.H, got.Percent, tc.h)
			}
			switch {
			case tc.recovers == nil && got.RecoversAt != nil:
				t.Fatalf("recovers at %v, want nil", got.RecoversAt)
			case tc.recovers != nil && (got.RecoversAt == nil || got.RecoversAt.Sub(*tc.recovers).Abs() > time.Second):
				t.Fatalf("recovers at %v, want %v", got.RecoversAt, tc.recovers)
			}
		})
	}
}

// TestScoreCandidatesOrderedPolicy verifies declared-order precedence, exhaustion fallback, unavailable/fault fallback,
// unknown headroom tolerance, and all-exhausted over_pace handling.
func TestScoreCandidatesOrderedPolicy(t *testing.T) {
	known := func(h float64) candidateHeadroom { return candidateHeadroom{Known: true, H: h, Percent: h * 100} }
	c := func(i int, usable bool, h candidateHeadroom, st candidateStats) scoreInput {
		return scoreInput{Index: i, Launcher: "launcher-" + string(rune('a'+i)), Model: "model-x", Usable: usable, Headroom: h, Stats: st}
	}
	none := candidateStats{}
	fastStats := candidateStats{N: 20, MinutesP50: 5, FirstPass: 1}
	slowStats := candidateStats{N: 20, MinutesP50: 60, FirstPass: 0.2}
	pooled := candidateStats{N: 40, MinutesP50: 25, FirstPass: 0.6}

	// Default pace mode picks candidate 1 when candidate 1 has unknown headroom (no penalty) or better stats.
	paceChoice := scoreCandidatesWithPolicy(
		[]scoreInput{c(0, true, known(0.35), slowStats), c(1, true, candidateHeadroom{}, fastStats)},
		pooled, candidatePolicyPace,
	)
	if paceChoice.Index != 1 || paceChoice.Reason != dispatchScore {
		t.Fatalf("default pace should prefer better-scoring candidate 1, got %+v", paceChoice)
	}

	// Ordered mode keeps declared order whenever candidate 0 is usable and has positive (or unknown) reserve headroom.
	cases := []struct {
		name   string
		in     []scoreInput
		index  int
		reason string
		skips  []string
	}{
		{
			name:   "candidate 0 positive reserve beats candidate 1 with higher headroom and faster stats",
			in:     []scoreInput{c(0, true, known(0.35), slowStats), c(1, true, known(0.90), fastStats)},
			index:  0,
			reason: dispatchFirst,
			skips:  []string{"", ""},
		},
		{
			name:   "candidate 0 positive reserve beats candidate 1 with unknown headroom",
			in:     []scoreInput{c(0, true, known(0.35), none), c(1, true, candidateHeadroom{}, fastStats)},
			index:  0,
			reason: dispatchFirst,
			skips:  []string{"", ""},
		},
		{
			name:   "candidate 0 unknown or stale headroom keeps declared order",
			in:     []scoreInput{c(0, true, candidateHeadroom{Stale: true}, none), c(1, true, known(0.90), fastStats)},
			index:  0,
			reason: dispatchFirst,
			skips:  []string{"", ""},
		},
		{
			name:   "candidate 0 exhausted (H=0) skips to candidate 1 with reason quota",
			in:     []scoreInput{c(0, true, known(0), none), c(1, true, known(0.50), none)},
			index:  1,
			reason: dispatchQuota,
			skips:  []string{dispatchQuota, ""},
		},
		{
			name:   "candidate 0 unavailable skips to candidate 1 with reason unavailable",
			in:     []scoreInput{c(0, false, known(0.90), none), c(1, true, known(0.35), none)},
			index:  1,
			reason: dispatchUnavailable,
			skips:  []string{dispatchUnavailable, ""},
		},
		{
			name:   "all usable candidates exhausted falls back to first usable with over_pace",
			in:     []scoreInput{c(0, false, candidateHeadroom{}, none), c(1, true, known(0), none), c(2, true, known(0), none)},
			index:  1,
			reason: dispatchOverPace,
			skips:  []string{dispatchUnavailable, dispatchQuota, dispatchQuota},
		},
		{
			name:   "no usable candidates returns -1 unavailable",
			in:     []scoreInput{c(0, false, candidateHeadroom{}, none), c(1, false, candidateHeadroom{}, none)},
			index:  -1,
			reason: dispatchUnavailable,
			skips:  []string{dispatchUnavailable, dispatchUnavailable},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scoreCandidatesWithPolicy(tc.in, pooled, candidatePolicyOrdered)
			if got.Index != tc.index || got.Reason != tc.reason {
				t.Fatalf("chose %d (%s), want %d (%s): %+v", got.Index, got.Reason, tc.index, tc.reason, got.Scores)
			}
			for i, line := range got.Scores {
				if line.Skip != tc.skips[i] {
					t.Errorf("candidate %d skip = %q, want %q", i, line.Skip, tc.skips[i])
				}
				if line.Score != nil {
					t.Errorf("ordered policy should not populate efficiency score for candidate %d, got %v", i, *line.Score)
				}
			}
		})
	}
}

// TestTierPickOrderedPolicyEndToEnd exercises pickTierCandidate, keepTierCandidate, dispatch/model_routing audit
// records, and GET /api/v1/model-profiles/{id}/candidates under both default pace and ordered policies.
func TestTierPickOrderedPolicyEndToEnd(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()

	f := newFakeHub().withMachine()
	f.launcherList = []proto.Launcher{{Name: "primary-cli"}, {Name: "backup-cli"}}
	ts := &trialTestStore{
		memStore: &memStore{},
		samples: map[string][]db.ModelRoutingSample{
			"dev": {
				{Tier: "dev", Launcher: "primary-cli", Model: "model-a", ActualMinutes: 50, FirstPass: false},
				{Tier: "dev", Launcher: "backup-cli", Model: "model-b", ActualMinutes: 8, FirstPass: true},
				{Tier: "dev", Launcher: "backup-cli", Model: "model-b", ActualMinutes: 10, FirstPass: true},
			},
		},
	}
	s := newServiceOn(t, f, ts)
	setSettings(t, s, func(v *Settings) { v.MachineID = "server" })
	if err := ts.PutSetting(ctx, launchersManagedKey, []storedLauncher{
		{ManagedLauncher: proto.ManagedLauncher{Name: "primary-cli", Agent: "agy"}},
		{ManagedLauncher: proto.ManagedLauncher{Name: "backup-cli", Agent: "claude"}},
	}); err != nil {
		t.Fatal(err)
	}
	pd := newPolicyDevices()
	s.devs = pd

	mkTier := func(policy string) ModelTier {
		return ModelTier{
			Launcher:        "primary-cli",
			Model:           "model-a",
			CandidatePolicy: policy,
			Candidates: []TierCandidate{
				{Launcher: "primary-cli", Model: "model-a"},
				{Launcher: "backup-cli", Model: "model-b"},
			},
		}
	}
	putTierProfiles(t, s, "economy",
		map[string]ModelTier{"dev": mkTier(candidatePolicyPace), "ordered-dev": mkTier(candidatePolicyOrdered)},
		nil,
	)

	// Scenario 1: Primary is 1d into 7d at 55% used (45% left > 10% reserve) with healthy 5h window (10% used).
	// Backup has abundant headroom.
	pd.setAccounts([]proto.UsageAccount{
		{
			ID: "p1", Provider: "antigravity", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 10, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 55, ""),
			},
		},
		{
			ID: "b1", Provider: "claude", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 5, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 5, ""),
			},
		},
	})

	// Default pace tier: skips primary on quota and chooses backup; no policy key in dispatch/detail.
	pacePick, err := s.pickTierCandidate(ctx, "dev", tierFacts{Machine: "server"})
	if err != nil {
		t.Fatal(err)
	}
	if pacePick.Candidate != 1 || pacePick.Tier.Launcher != "backup-cli" || pacePick.Reason != dispatchQuota {
		t.Fatalf("default pace pick = %+v, want candidate 1 (quota)", pacePick)
	}
	if d := pacePick.dispatch(); d.Args["policy"] != nil {
		t.Fatalf("default pace dispatch must omit policy arg: %+v", d.Args)
	}
	var paceDetail modelRoutingDetail
	if err := json.Unmarshal(modelRoutingOf(pacePick, "server").Detail, &paceDetail); err != nil || paceDetail.Policy != "" {
		t.Fatalf("default pace detail = %+v %v", paceDetail, err)
	}

	// Ordered tier: selects primary (candidate 0) even with negative weekly pace and worse 14-day stats.
	orderedPick, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server"})
	if err != nil {
		t.Fatal(err)
	}
	if orderedPick.Candidate != 0 || orderedPick.Tier.Launcher != "primary-cli" || orderedPick.Reason != dispatchFirst {
		t.Fatalf("ordered pick = %+v, want candidate 0 (first)", orderedPick)
	}
	if d := orderedPick.dispatch(); d.Args["policy"] != candidatePolicyOrdered {
		t.Fatalf("ordered dispatch missing policy arg: %+v", d.Args)
	}
	var orderedDetail modelRoutingDetail
	if err := json.Unmarshal(modelRoutingOf(orderedPick, "server").Detail, &orderedDetail); err != nil ||
		orderedDetail.Policy != candidatePolicyOrdered || len(orderedDetail.Scores) != 2 ||
		!orderedDetail.Scores[0].Headroom.Known || math.Abs(orderedDetail.Scores[0].Headroom.Percent-35) > 0.2 {
		t.Fatalf("ordered detail = %+v %v", orderedDetail, err)
	}

	// GET /api/v1/model-profiles/{id}/candidates matches each tier's own policy.
	w := request(s, http.MethodGet, "/api/v1/model-profiles/economy/candidates", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET candidates: %d %s", w.Code, w.Body.String())
	}
	var candView ModelProfileCandidatesView
	if err := json.Unmarshal(w.Body.Bytes(), &candView); err != nil {
		t.Fatal(err)
	}
	if candView.Tiers["dev"][0].Headroom.Percent != 0 || math.Abs(candView.Tiers["ordered-dev"][0].Headroom.Percent-35) > 0.2 {
		t.Fatalf("candidates view mismatch: pace=%+v ordered=%+v", candView.Tiers["dev"][0].Headroom, candView.Tiers["ordered-dev"][0].Headroom)
	}

	// Continuation under default pace switches away on quota (recovers > 2h); under ordered keeps primary.
	keepPace := &tierKeep{Prev: TaskDispatch{Tier: "dev", Candidate: 0, Of: 2, Launcher: "primary-cli", Model: "model-a"}}
	if got, err := s.pickTierCandidate(ctx, "dev", tierFacts{Machine: "server", Keep: keepPace}); err != nil ||
		got.Reason != dispatchSwitched || got.Candidate != 1 || got.Args["rule"] != switchQuota {
		t.Fatalf("pace continuation should switch on negative weekly pace: %+v %v", got, err)
	}
	keepOrdered := &tierKeep{Prev: TaskDispatch{Tier: "ordered-dev", Candidate: 0, Of: 2, Launcher: "primary-cli", Model: "model-a"}}
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server", Keep: keepOrdered}); err != nil ||
		got.Reason != dispatchKept || got.Candidate != 0 {
		t.Fatalf("ordered continuation should keep primary while reserve headroom > 0: %+v %v", got, err)
	}

	// Scenario 2: Weekly window truly exhausted (90% used == 10% reserve) -> ordered skips to backup and continuation switches.
	pd.setAccounts([]proto.UsageAccount{
		{
			ID: "p1", Provider: "antigravity", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 5, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 90, ""),
			},
		},
		{
			ID: "b1", Provider: "claude", SampledAt: now,
			Windows: []proto.UsageWindow{paceAt(now, "5h", 300, time.Hour, 5, "")},
		},
	})
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server"}); err != nil ||
		got.Candidate != 1 || got.Reason != dispatchQuota || !slices.Equal(got.dispatch().Args["passed_over"].([]string), []string{"primary-cli"}) {
		t.Fatalf("ordered weekly exhaustion should skip to backup: %+v %v", got, err)
	}
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server", Keep: keepOrdered}); err != nil ||
		got.Reason != dispatchSwitched || got.Candidate != 1 || got.Args["rule"] != switchQuota {
		t.Fatalf("ordered continuation should switch when weekly reserve is exhausted: %+v %v", got, err)
	}

	// Scenario 3: Short (5h) window exhausted (85% used == 15% reserve) despite ample weekly quota -> ordered skips to backup.
	pd.setAccounts([]proto.UsageAccount{
		{
			ID: "p1", Provider: "antigravity", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 85, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 20, ""),
			},
		},
		{
			ID: "b1", Provider: "claude", SampledAt: now,
			Windows: []proto.UsageWindow{paceAt(now, "5h", 300, time.Hour, 5, "")},
		},
	})
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server"}); err != nil ||
		got.Candidate != 1 || got.Reason != dispatchQuota {
		t.Fatalf("ordered 5h exhaustion should skip to backup: %+v %v", got, err)
	}

	// Scenario 4: Healthy quota, but primary launcher is in usage-limit cooldown (or failed health check) -> skips to backup.
	pd.setAccounts([]proto.UsageAccount{
		{
			ID: "p1", Provider: "antigravity", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 10, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 55, ""),
			},
		},
		{
			ID: "b1", Provider: "claude", SampledAt: now,
			Windows: []proto.UsageWindow{paceAt(now, "5h", 300, time.Hour, 5, "")},
		},
	})
	cooldownUntil := now.Add(2 * time.Hour)
	s.health.mu.Lock()
	s.health.loaded = true
	if s.health.recs == nil {
		s.health.recs = map[string]*LauncherHealth{}
	}
	s.health.recs[healthKey("server", "primary-cli")] = &LauncherHealth{
		Machine: "server", Launcher: "primary-cli", Agent: "agy",
		State: healthFailing, Kind: errKindUsageLimit, CheckedAt: now, ResetsAt: &cooldownUntil,
	}
	s.health.mu.Unlock()
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server"}); err != nil ||
		got.Candidate != 1 || got.Reason != dispatchUnavailable {
		t.Fatalf("ordered cooldown primary should skip to backup: %+v %v", got, err)
	}

	// Clearing cooldown restores primary selection.
	s.health.mu.Lock()
	s.health.recs[healthKey("server", "primary-cli")].State = healthOK
	s.health.mu.Unlock()
	if got, err := s.pickTierCandidate(ctx, "ordered-dev", tierFacts{Machine: "server"}); err != nil ||
		got.Candidate != 0 || got.Reason != dispatchFirst {
		t.Fatalf("ordered healthy primary after cooldown recovery: %+v %v", got, err)
	}

	// Scenario 5: Single-candidate tier with candidate_policy="ordered" stays unchanged (reason only, no extra args).
	putTierProfiles(t, s, "economy", map[string]ModelTier{
		"solo": {Launcher: "primary-cli", Model: "model-a", CandidatePolicy: candidatePolicyOrdered},
	}, nil)
	if got, err := s.pickTierCandidate(ctx, "solo", tierFacts{Machine: "server"}); err != nil ||
		got.Reason != tierReasonOnly || got.dispatch().Args != nil {
		t.Fatalf("single-candidate ordered tier should stay plain only: %+v %v", got, err)
	}
}

// TestCandidatePolicyValidationAndRollingCompatibility verifies validation rejection, canonicalization, older-client
// PUT preservation, explicit reset, and persona_settings model_profiles.tiers editing.
func TestCandidatePolicyValidationAndRollingCompatibility(t *testing.T) {
	ctx := context.Background()
	f := newFakeHub().withMachine()
	f.launcherList = []proto.Launcher{{Name: "claude"}, {Name: "fast", Model: "m-fast"}}
	s := newTestService(t, f)

	// Validation accepts "", "pace", "ordered" (with whitespace normalized) and rejects unknown/uppercase values.
	good := map[string]ModelTier{
		"a": {Launcher: "claude", CandidatePolicy: " pace "},
		"b": {Launcher: "claude", CandidatePolicy: " ordered "},
	}
	if err := checkModelTiers(good); err != nil {
		t.Fatalf("valid candidate policies rejected: %v", err)
	}
	if good["a"].CandidatePolicy != "" || good["b"].CandidatePolicy != candidatePolicyOrdered {
		t.Fatalf("policies not canonicalized: %+v", good)
	}
	for _, bad := range []string{"invalid", "ORDERED", "PACE", "exhaustion", "greedy"} {
		if err := checkModelTiers(map[string]ModelTier{"dev": {Launcher: "claude", CandidatePolicy: bad}}); err == nil {
			t.Errorf("invalid candidate_policy %q accepted", bad)
		}
	}

	// Seed a custom profile with candidate_policy="ordered".
	if _, err := s.saveModelProfile(ctx, nil, "custom", ProfileActor{Kind: "hub"}, func(p *ModelProfile, _ bool) error {
		p.Name = "Custom"
		p.Tiers = map[string]ModelTier{
			"dev": {
				Description:     "Development",
				CandidatePolicy: candidatePolicyOrdered,
				Candidates:      []TierCandidate{{Launcher: "fast", Model: "m-fast"}, {Launcher: "claude"}},
				Aliases:         []string{"standard"},
			},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	revision := func() int64 { ps, _ := storedTiers(t, s); return ps.Revision }
	tier := func(name string) ModelTier {
		t.Helper()
		ps, _ := storedTiers(t, s)
		got, ok := tierOf(ps, "custom", name)
		if !ok {
			t.Fatalf("tier %s missing", name)
		}
		return got
	}

	// Invalid policy on PUT returns 400 and leaves stored profile unchanged.
	badBody := `{"revision":` + jsonInt(revision()) + `,"name":"Custom","tiers":{"dev":{"launcher":"fast","candidate_policy":"bogus"}}}`
	if r := request(s, http.MethodPut, "/api/v1/model-profiles/custom", badBody); r.Code != http.StatusBadRequest {
		t.Fatalf("invalid PUT candidate_policy: %d %s", r.Code, r.Body.String())
	}
	if got := tier("dev"); got.CandidatePolicy != candidatePolicyOrdered {
		t.Fatalf("refused PUT mutated policy: %+v", got)
	}

	// Older client (Web/mobile shape with candidates/aliases but omitting candidate_policy) preserves "ordered".
	oldWebBody := `{"revision":` + jsonInt(revision()) + `,"name":"Custom","tiers":{"dev":{"launcher":"fast","model":"m-fast","description":"Development","candidates":[{"launcher":"fast","model":"m-fast"},{"launcher":"claude"}],"aliases":["standard"]}}}`
	if r := request(s, http.MethodPut, "/api/v1/model-profiles/custom", oldWebBody); r.Code != http.StatusOK {
		t.Fatalf("older-client PUT: %d %s", r.Code, r.Body.String())
	}
	if got := tier("dev"); got.CandidatePolicy != candidatePolicyOrdered {
		t.Fatalf("older-client PUT dropped candidate_policy: %+v", got)
	}

	// Older flat-shape client renaming the tier also preserves "ordered".
	renameBody := `{"revision":` + jsonInt(revision()) + `,"name":"Custom","tiers":{"build":{"launcher":"fast","model":"m-fast","description":"Development"}}}`
	if r := request(s, http.MethodPut, "/api/v1/model-profiles/custom", renameBody); r.Code != http.StatusOK {
		t.Fatalf("older-client rename PUT: %d %s", r.Code, r.Body.String())
	}
	if got := tier("build"); got.CandidatePolicy != candidatePolicyOrdered || len(got.Candidates) != 2 {
		t.Fatalf("older-client rename dropped policy or candidates: %+v", got)
	}

	// Explicit "pace" or "" resets candidate_policy back to default (omitted in JSON).
	resetBody := `{"revision":` + jsonInt(revision()) + `,"name":"Custom","tiers":{"build":{"launcher":"fast","model":"m-fast","description":"Development","candidate_policy":"pace"}}}`
	if r := request(s, http.MethodPut, "/api/v1/model-profiles/custom", resetBody); r.Code != http.StatusOK {
		t.Fatalf("reset PUT: %d %s", r.Code, r.Body.String())
	}
	if got := tier("build"); got.CandidatePolicy != "" {
		t.Fatalf("explicit pace did not reset policy: %+v", got)
	}
	rawJSON, err := json.Marshal(tier("build"))
	if err != nil || strings.Contains(string(rawJSON), "candidate_policy") {
		t.Fatalf("default policy must be omitted from JSON: %s %v", rawJSON, err)
	}

	// persona_settings model_profiles.tiers: invalid value refused before card; valid value shown and saved.
	tool := func(args string) (string, bool) {
		r := s.Tool(ctx, ToolCall{Name: "persona_settings", Arguments: json.RawMessage(args), MachineID: "server", SessionID: "c1"})
		return r.Content[0].Text, r.IsError
	}
	set := func(value string) (string, bool) {
		return tool(`{"action":"set","key":"model_profiles.tiers","value":` + value + `}`)
	}
	if out, isErr := set(`{"tier":"build","candidate_policy":"bogus","profiles":["custom"]}`); !isErr || len(s.pendingQuestions()) != 0 {
		t.Fatalf("bad candidate_policy via settings tool: %v %s", isErr, out)
	}
	// Setting "pace" when already default is a no-op.
	if out, isErr := set(`{"tier":"build","candidate_policy":"pace","profiles":["custom"]}`); isErr || !strings.Contains(out, "Nothing to change") {
		t.Fatalf("no-op pace edit: %v %s", isErr, out)
	}
	// Setting "ordered" shows [ordered] on the approval card and in get output.
	done := make(chan error, 1)
	go func() {
		q, ok := awaitCard(s)
		if !ok {
			done <- context.DeadlineExceeded
			return
		}
		if !strings.Contains(q.Summary, "[ordered]") {
			t.Errorf("approval card %q missing [ordered]", q.Summary)
		}
		allow := true
		raw, _ := json.Marshal(proto.Resolution{Allow: &allow})
		_, err := s.Action(ctx, Action{Op: "answer", InteractionID: q.ID, Answer: raw})
		done <- err
	}()
	if out, isErr := set(`{"tier":"build","candidate_policy":"ordered","profiles":["custom"]}`); isErr || !strings.Contains(out, "Saved tier build") {
		t.Fatalf("set ordered: %v %s", isErr, out)
	}
	if err := <-done; err != nil {
		t.Fatalf("answer card: %v", err)
	}
	if got := tier("build"); got.CandidatePolicy != candidatePolicyOrdered {
		t.Fatalf("saved tier missing ordered policy: %+v", got)
	}
	if out, isErr := tool(`{"action":"get","key":"model_profiles.tiers"}`); isErr || !strings.Contains(out, "[ordered]") {
		t.Fatalf("get tiers missing [ordered]: %v\n%s", isErr, out)
	}
}

// TestCandidatePolicyConcurrentAccess exercises concurrent tier picks, candidate-status reads, and profile saves
// toggling candidate_policy under -race with zero sleeps.
func TestCandidatePolicyConcurrentAccess(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	f := newFakeHub().withMachine()
	f.launcherList = []proto.Launcher{{Name: "primary-cli"}, {Name: "backup-cli"}}
	st := &memStore{}
	s := newServiceOn(t, f, st)
	setSettings(t, s, func(v *Settings) { v.MachineID = "server" })
	if err := st.PutSetting(ctx, launchersManagedKey, []storedLauncher{
		{ManagedLauncher: proto.ManagedLauncher{Name: "primary-cli", Agent: "agy"}},
		{ManagedLauncher: proto.ManagedLauncher{Name: "backup-cli", Agent: "claude"}},
	}); err != nil {
		t.Fatal(err)
	}
	s.devs = newPolicyDevices(
		proto.UsageAccount{
			ID: "p1", Provider: "antigravity", SampledAt: now,
			Windows: []proto.UsageWindow{
				paceAt(now, "5h", 300, time.Hour, 10, ""),
				paceAt(now, "7d", 10080, 24*time.Hour, 55, ""),
			},
		},
		proto.UsageAccount{
			ID: "b1", Provider: "claude", SampledAt: now,
			Windows: []proto.UsageWindow{paceAt(now, "5h", 300, time.Hour, 5, "")},
		},
	)
	putTierProfiles(t, s, "economy", map[string]ModelTier{
		"dev": {
			Launcher:        "primary-cli",
			Model:           "model-a",
			CandidatePolicy: candidatePolicyOrdered,
			Candidates: []TierCandidate{
				{Launcher: "primary-cli", Model: "model-a"},
				{Launcher: "backup-cli", Model: "model-b"},
			},
		},
	}, nil)

	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for g := range 6 {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			<-start
			for i := range 20 {
				pick, err := s.pickTierCandidate(ctx, "dev", tierFacts{Machine: "server"})
				if err != nil {
					errs <- err
					return
				}
				if pick.Policy == candidatePolicyOrdered && pick.Candidate != 0 {
					errs <- errModelProfileConflict
					return
				}
				if pick.Policy == "" && pick.Candidate != 1 {
					errs <- errModelProfileConflict
					return
				}
				if i%4 == 0 {
					if _, err := s.modelProfileCandidates(ctx, "economy"); err != nil {
						errs <- err
						return
					}
				}
			}
		}(g)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := range 16 {
			pol := candidatePolicyPace
			if i%2 == 0 {
				pol = candidatePolicyOrdered
			}
			if _, err := s.saveModelProfile(ctx, nil, "economy", ProfileActor{Kind: "hub"}, func(p *ModelProfile, _ bool) error {
				t := p.Tiers["dev"]
				t.CandidatePolicy = pol
				p.Tiers["dev"] = t
				return nil
			}); err != nil {
				errs <- err
				return
			}
		}
	}()
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent policy access error: %v", err)
	}
}
