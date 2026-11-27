package node

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/identity"
	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
	"github.com/nwverse/persona/server/internal/tokenuse"
)

func agyUsageStepLine(index int, typ, status string, ts time.Time, model string, in, out, cr, cw int64) string {
	m := map[string]any{
		"step_index": index,
		"type":       typ,
		"status":     status,
		"created_at": ts.UTC().Format(time.RFC3339),
	}
	if model != "" {
		m["model"] = model
	}
	if in != 0 {
		m["input_tokens"] = in
	}
	if out != 0 {
		m["output_tokens"] = out
	}
	if cr != 0 {
		m["cache_read_tokens"] = cr
	}
	if cw != 0 {
		m["cache_write_tokens"] = cw
	}
	b, _ := json.Marshal(m)
	return string(b) + "\n"
}

func writeAgyMeterTranscript(t *testing.T, root, conv, rel, body string) string {
	t.Helper()
	p := filepath.Join(root, "brain", conv, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUsageAgyParserAndStreaming(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	now := time.Date(2026, 11, 27, 12, 10, 15, 0, time.UTC)
	cutoff := now.Add(-usageWindow)
	root := filepath.Join(t.TempDir(), ".gemini", "antigravity-cli")
	const conv = "11111111-2222-4333-8444-555555555555"

	body := "" +
		// Before window: ignored.
		agyUsageStepLine(0, "PLANNER_RESPONSE", "DONE", now.Add(-30*time.Hour), "gemini-4-neon-high", 10, 20, 30, 0) +
		// Non-usage step types and malformed / synthetic / negative / all-zero lines: ignored.
		`{"step_index":1,"type":"USER_INPUT","status":"DONE","created_at":"` + now.Format(time.RFC3339) + `","content":"hello"}` + "\n" +
		`{"step_index":2,"type":"GENERIC","status":"DONE","created_at":"` + now.Format(time.RFC3339) + `","content":"ok","output_tokens":999}` + "\n" +
		`{"step_index":3,"type":"ERROR_MESSAGE","status":"ERROR","created_at":"` + now.Format(time.RFC3339) + `","output_tokens":999}` + "\n" +
		`not json at all` + "\n" +
		agyUsageStepLine(4, "PLANNER_RESPONSE", "DONE", now, "<synthetic>", 100, 200, 0, 0) +
		`{"step_index":5,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"` + now.Format(time.RFC3339) + `","model":"gemini-4-neon-high","input_tokens":-10,"output_tokens":-5}` + "\n" +
		`{"step_index":6,"type":"PLANNER_RESPONSE","status":"RUNNING","created_at":"` + now.Format(time.RFC3339) + `","model":"gemini-4-neon-high","input_tokens":0,"output_tokens":0}` + "\n" +
		// Step 7: streaming refresh RUNNING -> interleaved step 8 DONE -> step 7 RUNNING (duplicate) -> step 7 DONE (grew) -> anomalous smaller line (clamped, zero negative).
		agyUsageStepLine(7, "PLANNER_RESPONSE", "RUNNING", now, "gemini-4-neon-high", 1000, 50, 2000, 100) +
		agyUsageStepLine(8, "PLANNER_RESPONSE", "DONE", now.Add(time.Second), "claude-opus-5-5-high", 300, 120, 4000, 0) +
		agyUsageStepLine(7, "PLANNER_RESPONSE", "RUNNING", now, "gemini-4-neon-high", 1000, 50, 2000, 100) +
		agyUsageStepLine(7, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 1500, 450, 2500, 250) +
		agyUsageStepLine(7, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 900, 100, 1000, 50) +
		// Step 9: CHECKPOINT without model inherits latest PLANNER_RESPONSE model ("gemini-4-neon-high").
		`{"step_index":9,"type":"CHECKPOINT","status":"DONE","created_at":"` + now.Add(2*time.Second).Format(time.RFC3339) + `","input_tokens":200,"cache_read_tokens":6000,"output_tokens":300}` + "\n" +
		// Step 7 rewound with a new created_at: counts as a brand-new request.
		agyUsageStepLine(7, "PLANNER_RESPONSE", "DONE", now.Add(time.Minute), "gemini-4-neon-high", 400, 80, 1000, 0) +
		// Step 10: nested usage object with alt cache field names and updated_at fallback.
		`{"step_index":10,"type":"PLANNER_RESPONSE","status":"DONE","updated_at":"` + now.Add(time.Minute).Format(time.RFC3339) + `","model":"claude-opus-5-5-high","usage":{"input_tokens":700,"output_tokens":90,"cache_read_input_tokens":8000,"cache_creation_input_tokens":300,"cache_write_1h_tokens":400}}` + "\n" +
		// Partial trailing line: left unread until completed.
		`{"step_index":11,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"`

	path := writeAgyMeterTranscript(t, root, conv, agyTranscriptPath, body)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	m := newUsageMeter()
	ad := agyUsage{}
	m.scan(usagePath{path: path, st: st, ad: ad}, cutoff)

	min0 := now.Unix() / 60 * 60
	min1 := now.Add(time.Minute).Unix() / 60 * 60

	// Minute 0, gemini-4-neon-high: step 7 final (1500/450/2500/250, 1 req) + step 9 checkpoint (200/300/6000/0, 1 req).
	bGem0 := m.buckets[usageKey{min0, "gemini-4-neon-high", "", agyAgent}]
	if bGem0 == nil || bGem0.Input != 1700 || bGem0.Output != 750 || bGem0.CacheRead != 8500 || bGem0.CacheWrite != 250 || bGem0.Requests != 2 {
		t.Fatalf("min0 gemini = %+v", bGem0)
	}
	// Minute 0, claude-opus-5-5-high: step 8 (300/120/4000/0, 1 req).
	bCl0 := m.buckets[usageKey{min0, "claude-opus-5-5-high", "", agyAgent}]
	if bCl0 == nil || bCl0.Input != 300 || bCl0.Output != 120 || bCl0.CacheRead != 4000 || bCl0.CacheWrite != 0 || bCl0.Requests != 1 {
		t.Fatalf("min0 claude = %+v", bCl0)
	}
	// Minute 1, gemini-4-neon-high: rewound step 7 (400/80/1000/0, 1 req).
	bGem1 := m.buckets[usageKey{min1, "gemini-4-neon-high", "", agyAgent}]
	if bGem1 == nil || bGem1.Input != 400 || bGem1.Output != 80 || bGem1.CacheRead != 1000 || bGem1.Requests != 1 {
		t.Fatalf("min1 gemini = %+v", bGem1)
	}
	// Minute 1, claude-opus-5-5-high: step 10 nested usage (700/90/8000/400 via cache_write_1h_tokens > 300, 1 req).
	bCl1 := m.buckets[usageKey{min1, "claude-opus-5-5-high", "", agyAgent}]
	if bCl1 == nil || bCl1.Input != 700 || bCl1.Output != 90 || bCl1.CacheRead != 8000 || bCl1.CacheWrite != 400 || bCl1.Requests != 1 {
		t.Fatalf("min1 claude = %+v", bCl1)
	}

	// Complete the partial trailing line: only that new step is counted.
	tail := now.Add(time.Minute).Format(time.RFC3339) + `","model":"gemini-4-neon-high","input_tokens":10,"output_tokens":25}` + "\n"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(tail); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	st, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	m.dirty = map[usageKey]bool{}
	m.scan(usagePath{path: path, st: st, ad: ad}, cutoff)
	if bGem1.Input != 410 || bGem1.Output != 105 || bGem1.Requests != 2 || len(m.dirty) != 1 {
		t.Fatalf("after completing partial line: bucket=%+v dirty=%v", bGem1, m.dirty)
	}
}

func TestUsageAgyDeduplicationForksAndRewrite(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	n, home := testNode(t)
	now := time.Now().UTC().Truncate(time.Minute).Add(20 * time.Second)
	cutoff := now.Add(-usageWindow)
	root := filepath.Join(home, ".gemini", "antigravity-cli")

	const (
		convDual   = "aaaaaaaa-1111-4111-8111-111111111111"
		convFork   = "bbbbbbbb-2222-4222-8222-222222222222"
		convPeer   = "cccccccc-3333-4333-8333-333333333333"
		convFull   = "dddddddd-4444-4444-8444-444444444444"
		convAtomic = "eeeeeeee-5555-4555-8555-555555555555"
	)

	// 1. Both transcript.jsonl and transcript_full.jsonl exist: only transcript.jsonl is scanned (zero 2x double-count).
	shared := agyUsageStepLine(1, "PLANNER_RESPONSE", "RUNNING", now, "gemini-4-neon-high", 100, 50, 0, 0) +
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 1000, 200, 3000, 0)
	writeAgyMeterTranscript(t, root, convDual, agyTranscriptPath, shared)
	writeAgyMeterTranscript(t, root, convDual, agyFullTranscriptPath, shared)

	// 2. Fork copies convDual's finalized step 1 plus adds its own step 2.
	writeAgyMeterTranscript(t, root, convFork, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 1000, 200, 3000, 0)+
			agyUsageStepLine(2, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 500, 75, 1000, 0))

	// 3. Unrelated concurrent conversation at the exact same second & step_index & model with different counts: both count.
	writeAgyMeterTranscript(t, root, convPeer, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 777, 88, 999, 0))

	// 4. Full-only conversation (only transcript_full.jsonl initially).
	fullStep1 := agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "claude-opus-5-5-high", 400, 60, 0, 0)
	writeAgyMeterTranscript(t, root, convFull, agyFullTranscriptPath, fullStep1)

	// 5. Atomic rename rewrite test: starts with RUNNING draft (out=40).
	atomicPath := writeAgyMeterTranscript(t, root, convAtomic, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "RUNNING", now, "claude-opus-5-5-high", 200, 40, 0, 0))

	n.state.put(agyAgent+"-"+convDual, sessionState{Launcher: "agy"})
	n.state.put(agyAgent+"-"+convFork, sessionState{Launcher: "agy-fork"})
	n.state.put(agyAgent+"-"+convPeer, sessionState{Launcher: "agy"})
	n.state.put(agyAgent+"-"+convFull, sessionState{Launcher: "agy"})
	n.state.put(agyAgent+"-"+convAtomic, sessionState{Launcher: "agy-atomic"})

	m := newUsageMeter()
	m.launcherOf = func(session string) string {
		st, _ := n.usageSessionState(session)
		return st.Launcher
	}
	listed := n.usageFiles(cutoff)
	if len(listed) != 5 {
		t.Fatalf("listed %d files, want 5 (one per conversation): %+v", len(listed), listed)
	}
	for _, f := range listed {
		m.scan(f, cutoff)
	}

	minute := now.Unix() / 60 * 60
	// convDual + convPeer on launcher "agy", gemini-4-neon-high: (1000+777, 200+88, 3000+999, 2 req).
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "agy", agyAgent}]; b == nil || b.Input != 1777 || b.Output != 288 || b.CacheRead != 3999 || b.Requests != 2 {
		t.Fatalf("agy gemini bucket = %+v", b)
	}
	// convFork: step 1 deduplicated against convDual, only step 2 counted.
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "agy-fork", agyAgent}]; b == nil || b.Input != 500 || b.Output != 75 || b.CacheRead != 1000 || b.Requests != 1 {
		t.Fatalf("fork bucket = %+v", b)
	}
	// convFull: full-only file counted once.
	if b := m.buckets[usageKey{minute, "claude-opus-5-5-high", "agy", agyAgent}]; b == nil || b.Input != 400 || b.Output != 60 || b.Requests != 1 {
		t.Fatalf("full-only bucket = %+v", b)
	}
	// convAtomic: initial RUNNING draft counted (200 in, 40 out, 1 req).
	if b := m.buckets[usageKey{minute, "claude-opus-5-5-high", "agy-atomic", agyAgent}]; b == nil || b.Input != 200 || b.Output != 40 || b.Requests != 1 {
		t.Fatalf("atomic initial bucket = %+v", b)
	}

	// Now convFull gains transcript.jsonl containing step 1 (already counted from transcript_full.jsonl) + new step 2.
	writeAgyMeterTranscript(t, root, convFull, agyTranscriptPath,
		fullStep1+agyUsageStepLine(2, "PLANNER_RESPONSE", "DONE", now, "claude-opus-5-5-high", 100, 30, 0, 0))

	// And convAtomic is atomically replaced via rename (new inode, larger size) with ONLY the DONE line (no RUNNING line) + step 2.
	tmp := atomicPath + ".tmp"
	rewritten := agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "claude-opus-5-5-high", 600, 140, 500, 0) +
		agyUsageStepLine(2, "PLANNER_RESPONSE", "DONE", now, "claude-opus-5-5-high", 50, 20, 0, 0)
	if err := os.WriteFile(tmp, []byte(rewritten), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, atomicPath); err != nil {
		t.Fatal(err)
	}

	for _, f := range n.usageFiles(cutoff) {
		m.scan(f, cutoff)
	}
	// convFull switched to transcript.jsonl without double-counting step 1: total = 500 in, 90 out, 2 req.
	if b := m.buckets[usageKey{minute, "claude-opus-5-5-high", "agy", agyAgent}]; b == nil || b.Input != 500 || b.Output != 90 || b.Requests != 2 {
		t.Fatalf("after full->compact switch: %+v", b)
	}
	// convAtomic: step 1 delta (+400 in, +100 out, +500 cache_read, 0 extra req) + step 2 (50 in, 20 out, 1 req) => 650 in, 160 out, 500 cr, 2 req.
	if b := m.buckets[usageKey{minute, "claude-opus-5-5-high", "agy-atomic", agyAgent}]; b == nil || b.Input != 650 || b.Output != 160 || b.CacheRead != 500 || b.Requests != 2 {
		t.Fatalf("after atomic rename rewrite: %+v", b)
	}

	// Re-scanning unchanged files produces zero new deltas.
	m.dirty = map[usageKey]bool{}
	for _, f := range n.usageFiles(cutoff) {
		m.scan(f, cutoff)
	}
	if len(m.dirty) != 0 {
		t.Fatalf("unchanged rescan dirtied buckets: %v", m.dirty)
	}
}

// Regression test: usage lines without a non-negative step_index (omitted or negative) must carry a deterministic
// dedup key so atomic inode replacement or file truncation rewinding to offset 0 never double-counts them.
func TestUsageAgyKeylessAtomicRewriteAndTruncationIdempotent(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	n, home := testNode(t)
	now := time.Now().UTC().Truncate(time.Minute).Add(15 * time.Second)
	cutoff := now.Add(-usageWindow)
	root := filepath.Join(home, ".gemini", "antigravity-cli")
	const conv = "ffffffff-6666-4666-8666-666666666666"

	lineNilIndex := fmt.Sprintf(`{"type":"PLANNER_RESPONSE","status":"DONE","created_at":%q,"model":"gemini-4-neon-high","input_tokens":100,"output_tokens":10}`+"\n",
		now.Format(time.RFC3339))
	lineNegIndex := fmt.Sprintf(`{"step_index":-1,"type":"PLANNER_RESPONSE","status":"DONE","created_at":%q,"model":"gemini-4-neon-high","input_tokens":200,"output_tokens":25}`+"\n",
		now.Add(time.Second).Format(time.RFC3339))
	lineNewKeyless := fmt.Sprintf(`{"type":"PLANNER_RESPONSE","status":"DONE","created_at":%q,"model":"gemini-4-neon-high","input_tokens":300,"output_tokens":40}`+"\n",
		now.Add(2*time.Second).Format(time.RFC3339))

	path := writeAgyMeterTranscript(t, root, conv, agyTranscriptPath, lineNilIndex+lineNegIndex)
	m := newUsageMeter()
	scanAll := func() {
		for _, f := range n.usageFiles(cutoff) {
			m.scan(f, cutoff)
		}
	}

	// 1. Initial scan counts both keyless lines once (input=300, output=35, req=2).
	scanAll()
	minute := now.Unix() / 60 * 60
	key := usageKey{minute, "gemini-4-neon-high", "", agyAgent}
	if b := m.buckets[key]; b == nil || b.Input != 300 || b.Output != 35 || b.Requests != 2 {
		t.Fatalf("initial keyless bucket = %+v, want input=300 output=35 req=2", b)
	}

	// 2. Atomic rename replacement (new inode, growing with a 3rd keyless line): earlier two lines are not double-counted.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(lineNilIndex+lineNegIndex+lineNewKeyless), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
	scanAll()
	if b := m.buckets[key]; b == nil || b.Input != 600 || b.Output != 75 || b.Requests != 3 {
		t.Fatalf("after atomic rename = %+v, want input=600 output=75 req=3", b)
	}

	// 3. Truncation / shrinking rewrite back to the first keyless line: zero double-counting and zero dirty buckets.
	m.dirty = map[usageKey]bool{}
	if err := os.WriteFile(path, []byte(lineNilIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	scanAll()
	if b := m.buckets[key]; b == nil || b.Input != 600 || b.Output != 75 || b.Requests != 3 || len(m.dirty) != 0 {
		t.Fatalf("after shrinking rewrite = %+v dirty=%v, want unchanged input=600 output=75 req=3", b, m.dirty)
	}
}

func TestUsageAgyAttributionAndBackfill(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	n, home := testNode(t)
	now := time.Now().UTC().Truncate(time.Minute).Add(10 * time.Second)
	cutoff := now.Add(-usageWindow)

	defRoot := filepath.Join(home, ".gemini", "antigravity-cli")

	const (
		convAsst       = "10000000-0000-4000-8000-000000000001"
		convTrack      = "10000000-0000-4000-8000-000000000002"
		convSubagent   = "10000000-0000-4000-8000-000000000003"
		convPane       = "10000000-0000-4000-8000-000000000004"
		convStandalone = "10000000-0000-4000-8000-000000000006"
	)

	asstDir := identity.AssistantDir(home)
	trackDir := filepath.Join(identity.DataDir(home), "tracks", "core")
	paneDir := filepath.Join(home, "code", "pane-repo")
	cliDir := filepath.Join(home, "code", "my repo")
	if !identity.IsAssistantDir(asstDir) || !identity.IsAssistantDir(trackDir) {
		t.Fatalf("expected assistant and tracks dirs to classify as assistant: %q %q", asstDir, trackDir)
	}

	// Assistant, track supervisor, and subagent of track supervisor.
	writeAgyMeterTranscript(t, defRoot, convAsst, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 100, 50, 0, 0))
	writeAgyMeterTranscript(t, defRoot, convTrack, agyTranscriptPath,
		`{"step_index":0,"type":"USER_INPUT","source":"USER_EXPLICIT","created_at":"`+now.Format(time.RFC3339)+`","content":"plan"}`+"\n"+
			agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 200, 60, 0, 0))
	subPath := writeAgyMeterTranscript(t, defRoot, convSubagent, agyTranscriptPath,
		`{"step_index":0,"type":"SYSTEM_MESSAGE","source":"SYSTEM","created_at":"`+now.Format(time.RFC3339)+`","content":"[Message] sender=`+convTrack+` content=do subwork"}`+"\n"+
			agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 300, 70, 0, 0))
	// Terminal pane agy session.
	writeAgyMeterTranscript(t, defRoot, convPane, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 400, 80, 0, 0))
	// Standalone CLI session attributed via conversation_summaries.db (when sqlite3 is available).
	standalonePath := writeAgyMeterTranscript(t, defRoot, convStandalone, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 600, 100, 0, 0))

	n.state.put(agyAgent+"-"+convAsst, sessionState{Launcher: "agy-main", Cwd: asstDir})
	n.state.put(agyAgent+"-"+convTrack, sessionState{Launcher: "agy-track", Cwd: trackDir})
	n.state.put("agy-ws-p1", sessionState{Launcher: "agy-pane", Cwd: paneDir})
	n.rememberAgyPanes(map[string]string{"agy-ws-p1": convPane}, now)

	if _, err := exec.LookPath("sqlite3"); err == nil {
		dbPath := filepath.Join(defRoot, "conversation_summaries.db")
		cliURI, _ := json.Marshal([]string{"file://" + strings.ReplaceAll(cliDir, " ", "%20")})
		trackURI, _ := json.Marshal([]string{"file://" + trackDir})
		stmt := fmt.Sprintf(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT);
INSERT INTO conversation_summaries VALUES ('%s', '%s');
INSERT INTO conversation_summaries VALUES ('%s', '%s');`,
			convStandalone, strings.ReplaceAll(string(cliURI), "'", "''"),
			convTrack, strings.ReplaceAll(string(trackURI), "'", "''"))
		if out, err := exec.Command("sqlite3", dbPath, stmt).CombinedOutput(); err != nil {
			t.Fatalf("sqlite3: %v %s", err, out)
		}
		ad := agyUsage{node: n}
		if got := ad.startDir(standalonePath); got != filepath.Clean(cliDir) {
			t.Fatalf("standalone startDir = %q, want %q", got, filepath.Clean(cliDir))
		}
		// Subagent inherits parent track directory from conversation_summaries.db (cached in agySummaryDirCache).
		if got := ad.startDir(subPath); got != filepath.Clean(trackDir) {
			t.Fatalf("subagent startDir = %q, want %q", got, filepath.Clean(trackDir))
		}
	}

	m := newUsageMeter()
	m.launcherOf = func(session string) string {
		st, _ := n.usageSessionState(session)
		return st.Launcher
	}

	paths := n.usageFiles(cutoff)
	if len(paths) != 5 {
		t.Fatalf("listed %d paths, want 5: %+v", len(paths), paths)
	}
	for _, f := range paths {
		m.scan(f, cutoff)
	}

	minute := now.Unix() / 60 * 60
	// Assistant conversation -> agy-main.
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "agy-main", agyAgent}]; b == nil || b.Output != 50 {
		t.Fatalf("assistant bucket = %+v", b)
	}
	// Track supervisor + its subagent -> both under agy-track!
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "agy-track", agyAgent}]; b == nil || b.Output != 130 || b.Requests != 2 {
		t.Fatalf("track + subagent bucket = %+v", b)
	}
	// Terminal pane -> agy-pane via usageSessionState fallback.
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "agy-pane", agyAgent}]; b == nil || b.Output != 80 {
		t.Fatalf("pane bucket = %+v", b)
	}
	// Standalone CLI -> "" launcher.
	if b := m.buckets[usageKey{minute, "gemini-4-neon-high", "", agyAgent}]; b == nil || b.Output != 100 {
		t.Fatalf("standalone CLI bucket = %+v", b)
	}

	// ANTIGRAVITY_CLI_CONFIG_DIR symlink override works cleanly.
	customRoot := filepath.Join(t.TempDir(), "custom-agy")
	const convCustom = "10000000-0000-4000-8000-000000000007"
	writeAgyMeterTranscript(t, customRoot, convCustom, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 700, 110, 0, 0))
	linkRoot := filepath.Join(t.TempDir(), "custom-agy-link")
	if err := os.Symlink(customRoot, linkRoot); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", linkRoot)
	if customPaths := (agyUsage{node: n}).paths(n, cutoff); len(customPaths) != 1 {
		t.Fatalf("custom symlinked root paths = %v, want 1", customPaths)
	}
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")

	// Scoped node excludes agy files.
	scoped := scopedTestNode(t)
	writeAgyMeterTranscript(t, filepath.Join(scoped.home, ".gemini", "antigravity-cli"), convAsst, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 10, 20, 0, 0))
	if got := (agyUsage{node: scoped}).paths(scoped, cutoff); len(got) != 0 {
		t.Fatalf("scoped node returned agy paths: %v", got)
	}

	// Backfill with created_at timestamps and startOffset on a large (>4 MiB) agy file.
	oldHour := now.Add(-48 * time.Hour).Truncate(time.Hour)
	const convOld = "10000000-0000-4000-8000-000000000099"
	oldPath := writeAgyMeterTranscript(t, defRoot, convOld, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", oldHour.Add(5*time.Minute), "gemini-4-neon-high", 111, 222, 333, 0))
	if err := os.Chtimes(oldPath, oldHour.Add(5*time.Minute), oldHour.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	lim := &readLimiter{rate: 1 << 40, start: time.Now()}
	bfiles := n.backfillFiles(context.Background(), oldHour.Add(-time.Hour), lim)
	gotBackfill, err := n.backfillScan(context.Background(), bfiles, nil, oldHour, oldHour.Add(time.Hour), lim)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotBackfill) != 1 || gotBackfill[0].Agent != agyAgent || gotBackfill[0].Output != 222 || gotBackfill[0].Minute != oldHour.Unix() {
		t.Fatalf("agy backfill = %+v", gotBackfill)
	}

	// startOffset skips pre-cutoff agy lines using created_at.
	var big strings.Builder
	pad := strings.Repeat("p", 4000)
	for i := 0; big.Len() < 5<<20; i++ {
		fmt.Fprintf(&big, `{"step_index":%d,"type":"USER_INPUT","created_at":%q,"content":%q}`+"\n", i, now.Add(-5*time.Hour).Format(time.RFC3339), pad)
	}
	oldLen := big.Len()
	big.WriteString(agyUsageStepLine(9999, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 12, 34, 56, 0))
	bigPath := filepath.Join(t.TempDir(), "big-agy.jsonl")
	if err := os.WriteFile(bigPath, []byte(big.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	off := startOffset(bigPath, int64(big.Len()), now.Add(-time.Hour))
	if off == 0 || off > int64(oldLen) {
		t.Fatalf("agy startOffset = %d, want inside old prefix (<= %d)", off, oldLen)
	}
}

// Anti-double-counting proof: because agy is file-metered (tokenuse.FileMetered("agy") == true), a step scanned from
// the local agy transcript and simultaneously submitted via runtime usage.report is counted strictly once (never 2x).
func TestUsageAgyNoDoubleCountWithRuntimeReport(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	if !tokenuse.FileMetered(agyAgent) {
		t.Fatal("agy must be in tokenuse.FileAgents()")
	}
	n, home := testNode(t)
	var out bytes.Buffer
	n.peer = rpc.New("test", &out)
	n.runtimes = newRuntimeRegistry()
	h := n.runtimes.add(nil)
	h.ready = true
	h.hello.Runtime = agyAgent
	h.hello.Agent = agyAgent

	const conv = "99999999-8888-4777-8666-555555555555"
	sid := agyAgent + "-" + conv
	n.runtimes.setSessions(h, []proto.Session{{SessionID: sid, Agent: agyAgent, Cwd: home}})
	n.state.put(sid, sessionState{Launcher: agyAgent, Cwd: home})

	now := time.Now().UTC().Truncate(time.Minute).Add(15 * time.Second)
	cutoff := now.Add(-usageWindow)
	writeAgyMeterTranscript(t, filepath.Join(home, ".gemini", "antigravity-cli"), conv, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 1200, 450, 5000, 300))

	// 1. File meter scans the step once.
	m := newUsageMeter()
	m.launcherOf = func(session string) string {
		st, _ := n.usageSessionState(session)
		return st.Launcher
	}
	for _, f := range n.usageFiles(cutoff) {
		m.scan(f, cutoff)
	}

	// 2. Runtime simultaneously emits usage.report for the exact same agy session/step.
	host := &RuntimeHost{reg: n.runtimes, node: n}
	payload, _ := json.Marshal(map[string]any{
		"session_id":  sid,
		"request_id":  "step-1",
		"ts":          now.Format(time.RFC3339Nano),
		"model":       "gemini-4-neon-high",
		"input":       1200,
		"output":      450,
		"cache_read":  5000,
		"cache_write": 300,
	})
	host.event(h, "usage.report", payload)
	n.flushRuntimeUsage()
	if out.Len() != 0 {
		t.Fatalf("runtime usage.report for file-metered agy must be rejected, emitted: %s", out.String())
	}

	// Total counted across the whole node is strictly 1x.
	minute := now.Unix() / 60 * 60
	b := m.buckets[usageKey{minute, "gemini-4-neon-high", agyAgent, agyAgent}]
	if b == nil || b.Input != 1200 || b.Output != 450 || b.CacheRead != 5000 || b.CacheWrite != 300 || b.Requests != 1 {
		t.Fatalf("file meter bucket = %+v, want exact 1x counts", b)
	}
}

// Restart / reconnect continuity: a fresh usageMeter on a restarted node reconstructs the identical full window from
// disk with zero token loss and zero duplication.
func TestUsageAgyRestartRebuildsIdenticalFullWindow(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	n, home := testNode(t)
	now := time.Now().UTC().Truncate(time.Minute).Add(30 * time.Second)
	cutoff := now.Add(-usageWindow)
	root := filepath.Join(home, ".gemini", "antigravity-cli")

	const conv = "77777777-6666-4555-8444-333333333333"
	writeAgyMeterTranscript(t, root, conv, agyTranscriptPath,
		agyUsageStepLine(1, "PLANNER_RESPONSE", "RUNNING", now.Add(-time.Minute), "gemini-4-neon-high", 100, 20, 0, 0)+
			agyUsageStepLine(1, "PLANNER_RESPONSE", "DONE", now.Add(-time.Minute), "gemini-4-neon-high", 500, 150, 2000, 0)+
			agyUsageStepLine(2, "PLANNER_RESPONSE", "DONE", now, "gemini-4-neon-high", 600, 250, 3000, 100))
	n.state.put(agyAgent+"-"+conv, sessionState{Launcher: "agy"})

	runMeter := func() (bool, map[usageKey]proto.UsageBucket) {
		m := newUsageMeter()
		m.launcherOf = func(session string) string {
			st, _ := n.usageSessionState(session)
			return st.Launcher
		}
		for _, f := range n.usageFiles(cutoff) {
			m.scan(f, cutoff)
		}
		params, ok := m.report(now)
		if !ok {
			t.Fatal("expected full report")
		}
		got := map[usageKey]proto.UsageBucket{}
		for _, b := range params["buckets"].([]proto.UsageBucket) {
			got[usageKey{b.Minute, b.Model, b.Launcher, b.Agent}] = b
		}
		return params["full"].(bool), got
	}

	full1, first := runMeter()
	full2, restarted := runMeter()
	if !full1 || !full2 || len(first) != 2 || len(restarted) != 2 {
		t.Fatalf("full=%v/%v len=%d/%d", full1, full2, len(first), len(restarted))
	}
	for k, want := range first {
		if got := restarted[k]; got != want {
			t.Fatalf("after restart bucket %+v = %+v, want %+v", k, got, want)
		}
	}
}
