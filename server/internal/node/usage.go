package node

import (
	"bytes"
	"cmp"
	"context"
	"hash/fnv"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/sysmon"
	"github.com/nwverse/persona/server/internal/tokenuse"
)

// Token usage of every agent on this machine, for the Dynamic Island's TPM / today's tokens / requests (docs/apple/live-activity.md).
// The agents' records are the record: each agent's adapter (usage_adapters.go) says which files hold its usage and
// parses them (tokenuse): Claude Code writes each reply's usage on its assistant lines (main and subagent files), Codex
// and compatible variants a token_count event per request. The meter reads only what the files gained since the last
// scan, sums it per minute and model for the last usageWindow, and reports changed minutes to the hub as "usage".
// A node starts with the hub connection, so a fresh meter re-reads the window from the files and sends it whole
// ("full"): nothing is stored, and restarting either side recounts the same numbers; the manager keeps the week
// (docs/server/machines.md "Token usage"). Runtime reports are separate deltas (runtime_usage.go).
//
// Each bucket also says which launcher ran it (the session's, as Persona started it; "" for one typed in a terminal)
// and which agent (its adapter's), and a reply is counted once in the window even when it is in more than one file: a
// fork (Claude Code's --fork-session, Codex's fork) copies the history it starts from, timestamps and all, into the
// new file.

const (
	usageWindow  = 26 * time.Hour // "today" in any time zone, and the hour before
	usageEvery   = 10 * time.Second
	usageMaxRead = 64 << 20 // per file and scan; a backlog continues on the next scan
	usageMaxLine = 16 << 20 // longer lines (pictures) are skipped: usage lines are small
)

type usageKey struct {
	minute   int64
	model    string
	launcher string
	agent    string
}

type usageTokens struct {
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
}

func (t usageTokens) zero() bool {
	return t.input == 0 && t.output == 0 && t.cacheRead == 0 && t.cacheWrite == 0
}

type usageRecord struct {
	time      time.Time
	agent     string
	session   string
	model     string
	key       string
	parentKey string // when non-empty, groups streaming updates of one step in the same file
	more      bool
	tokens    usageTokens
}

type usageParser interface {
	line(b []byte) (usageRecord, bool)
}

type tokenuseParser struct{ p tokenuse.Parser }

func (w tokenuseParser) line(b []byte) (usageRecord, bool) {
	r, ok := w.p.Line(b)
	if !ok {
		return usageRecord{}, false
	}
	return usageRecordFromTokenuse(r), true
}

func usageRecordFromTokenuse(r tokenuse.Record) usageRecord {
	return usageRecord{
		time: r.Time, agent: r.Agent, session: r.Session, model: r.Model, key: r.Key, more: r.More,
		tokens: usageTokens{input: r.Input, output: r.Output, cacheRead: r.CacheRead, cacheWrite: r.CacheWrite},
	}
}

type usageStep struct {
	skip bool
	at   usageKey
}

type usageFile struct {
	session string // its session or thread id (usageAdapter.session)
	info    os.FileInfo
	off     int64
	parser  usageParser
	// The request of the file's latest record that was not More: skip, it was not counted (before the window, after
	// the backfill's end, a copy counted in another file), so its More records are not either; else at, its bucket.
	skip  bool
	at    usageKey
	steps map[string]usageStep // keyed by parentKey when a format can refresh non-adjacent steps in place (agy)
}

type usageMeter struct {
	files   map[string]*usageFile
	buckets map[usageKey]*proto.UsageBucket
	dirty   map[usageKey]bool
	// counted: every reply counted in the window (its record's Key: Claude's message id, Codex's timestamp and running
	// total), and the minute it is in, so a fork's copy of it in another file is not counted again.
	counted map[string]int64
	// launcherOf names the launcher of a session ("" unknown); nil: none.
	launcherOf func(session string) string
	sent       bool // the first report (full) is out
	sentAt     time.Time
	// The backfill's (usage_backfill.go): step, its buckets' seconds (0: a minute); until, where it stops counting
	// (the live window's start); seen instead of counted, the replies it counted by a hash (a year of reply ids would
	// be large).
	step  int64
	until time.Time
	seen  map[uint64]struct{}
}

func newUsageMeter() *usageMeter {
	return &usageMeter{files: map[string]*usageFile{}, buckets: map[usageKey]*proto.UsageBucket{}, dirty: map[usageKey]bool{},
		counted: map[string]int64{}}
}

// usagePath is a file usageFiles lists, with the stat that found it in the window (scan reads up to its size) and the
// adapter of the agent it is of.
type usagePath struct {
	path string
	st   os.FileInfo
	ad   usageAdapter
}

// usageFiles lists the files that may hold usage of the window, every adapter's (usageAdapters): Claude Code's
// transcripts (every config directory, their subagents and their workflow runs' agents), Codex's and the compatible
// CLI's rollouts.
func (n *Node) usageFiles(cutoff time.Time) []usagePath {
	var out []usagePath
	for _, ad := range n.usageAdapters() {
		for _, p := range ad.paths(n, cutoff) {
			if st, err := os.Stat(p); err == nil && st.ModTime().After(cutoff) && n.scopedTranscriptAllows(p) {
				out = append(out, usagePath{p, st, ad})
			}
		}
	}
	return out
}

// meterUsage scans every usageEvery and reports what changed.
func (n *Node) meterUsage(ctx context.Context, stateLoaded <-chan struct{}) {
	// A first full scan cannot be reattributed after offsets and reply IDs are consumed. Do not replace the hub's
	// window until launcher state has loaded successfully (stateReady); a failed first try leaves this waiting until a
	// later try on this connection loads it (reloadState), or the connection ends.
	select {
	case <-ctx.Done():
		return
	case <-stateLoaded:
	}
	if ctx.Err() != nil {
		return
	}
	m := newUsageMeter()
	m.launcherOf = func(session string) string {
		st, _ := n.usageSessionState(session)
		return st.Launcher
	}
	queries := n.usageQueries()
	t := time.NewTicker(usageEvery)
	defer t.Stop()
	for {
		now := time.Now()
		cutoff := now.Add(-usageWindow)
		for _, f := range n.usageFiles(cutoff) {
			if ctx.Err() != nil {
				return
			}
			m.scan(f, cutoff)
		}
		for _, q := range queries {
			for _, r := range q.poll(ctx, n, cutoff) {
				m.add(&usageFile{}, usageRecordFromTokenuse(r), cutoff)
			}
		}
		m.prune(cutoff)
		n.flushRuntimeUsage()
		if n.peer != nil {
			if params, ok := m.report(now); ok {
				params["load"], params["cpus"] = loadAverage(), runtime.NumCPU()
				_ = n.peer.Notify("usage", params)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// newUsageFile is the meter's state of a file it reads for the first time, read from off.
func newUsageFile(f usagePath, off int64) *usageFile {
	return &usageFile{session: f.ad.session(f.path), off: off, parser: f.ad.parser()}
}

// scan reads what f gained since the last scan (a file seen for the first time: from about the cutoff), up to the
// size its stat (usageFiles') says; what it gains after that is read on the next sweep.
func (m *usageMeter) scan(f usagePath, cutoff time.Time) {
	uf := m.files[f.path]
	if uf == nil {
		uf = newUsageFile(f, startOffset(f.path, f.st.Size(), cutoff))
		m.files[f.path] = uf
	}
	replaced := uf.info != nil && !os.SameFile(uf.info, f.st)
	if f.st.Size() < uf.off || replaced { // rewritten or replaced
		prevParser, prevSteps := uf.parser, uf.steps
		*uf = *newUsageFile(f, 0)
		if ap, ok := prevParser.(*agyUsageParser); ok {
			ap.model = ""
			uf.parser = ap
			uf.steps = prevSteps
		}
	}
	if f.st.Size() == uf.off && !replaced {
		return
	}
	fh, err := os.Open(f.path)
	if err != nil {
		return
	}
	defer fh.Close()
	uf.info = f.st
	end := min(f.st.Size(), uf.off+usageMaxRead)
	uf.off += eachLine(io.NewSectionReader(fh, uf.off, end-uf.off), func(line []byte) {
		if r, ok := uf.parser.line(line); ok {
			m.add(uf, r, cutoff)
		}
	})
}

func (m *usageMeter) seenKey(key string) bool {
	if key == "" {
		return false
	}
	if m.seen != nil {
		h := fnv.New64a()
		h.Write([]byte(key))
		_, ok := m.seen[h.Sum64()]
		return ok
	}
	_, ok := m.counted[key]
	return ok
}

func (m *usageMeter) markKey(key string, minute int64) {
	if key == "" {
		return
	}
	if m.seen != nil {
		h := fnv.New64a()
		h.Write([]byte(key))
		m.seen[h.Sum64()] = struct{}{}
		return
	}
	m.counted[key] = minute
}

// add counts a record of uf's session: a request, or more of an earlier one (more). A request before cutoff or
// from the meter's until on is not counted, nor one whose key was counted already (a copy in another file); a record
// without a key is counted as it is.
func (m *usageMeter) add(uf *usageFile, r usageRecord, cutoff time.Time) {
	if r.more {
		if r.parentKey != "" {
			step, ok := uf.steps[r.parentKey]
			if !ok || step.skip || m.seenKey(r.key) {
				return
			}
			m.addTo(step.at, r.tokens, false)
			m.markKey(r.key, step.at.minute)
			return
		}
		if !uf.skip {
			m.addTo(uf.at, r.tokens, false)
		}
		return
	}
	recordStep := func(skip bool, at usageKey) {
		if r.parentKey == "" {
			return
		}
		if uf.steps == nil {
			uf.steps = map[string]usageStep{}
		}
		uf.steps[r.parentKey] = usageStep{skip: skip, at: at}
	}
	uf.skip = true
	if r.time.Before(cutoff) || !m.until.IsZero() && !r.time.Before(m.until) {
		recordStep(true, usageKey{})
		return
	}
	step := m.step
	if step <= 0 {
		step = 60
	}
	minute := r.time.Unix() / step * step
	if m.seenKey(r.key) {
		recordStep(true, usageKey{})
		return
	}
	m.markKey(r.key, minute)
	model := r.model
	if model == "" {
		model = "unknown"
	}
	session := uf.session
	if r.session != "" { // a database's row says its session
		session = r.session
	}
	launcher := ""
	if m.launcherOf != nil && session != "" {
		launcher = m.launcherOf(session)
	}
	uf.skip, uf.at = false, usageKey{minute, model, launcher, r.agent}
	recordStep(false, uf.at)
	m.addTo(uf.at, r.tokens, true)
}

// addTo adds t to bucket k, and a request with request.
func (m *usageMeter) addTo(k usageKey, t usageTokens, request bool) {
	b := m.buckets[k]
	if b == nil {
		b = &proto.UsageBucket{Minute: k.minute, Model: k.model, Launcher: k.launcher, Agent: k.agent}
		m.buckets[k] = b
	}
	b.Input += t.input
	b.CacheWrite += t.cacheWrite
	b.CacheRead += t.cacheRead
	b.Output += t.output
	if request {
		b.Requests++
	}
	m.dirty[k] = true
}

func (m *usageMeter) prune(cutoff time.Time) {
	for k := range m.buckets {
		if k.minute < cutoff.Unix()/60*60 {
			delete(m.buckets, k)
			delete(m.dirty, k)
		}
	}
	for r, minute := range m.counted {
		if minute < cutoff.Unix()/60*60 {
			delete(m.counted, r)
		}
	}
	for p := range m.files {
		if st, err := os.Stat(p); err != nil || st.ModTime().Before(cutoff) {
			delete(m.files, p)
		}
	}
}

// report returns the "usage" notification: every bucket the first time (full), then the changed ones; nothing when
// nothing changed, except a load update each minute. "launchers": the buckets say their launcher (an older node's
// have none, and the apps cannot filter its usage by launcher).
func (m *usageMeter) report(now time.Time) (map[string]any, bool) {
	full := !m.sent
	if !full && len(m.dirty) == 0 && now.Sub(m.sentAt) < time.Minute {
		return nil, false
	}
	list := []proto.UsageBucket{}
	for k, b := range m.buckets {
		if full || m.dirty[k] {
			list = append(list, *b)
		}
	}
	m.dirty = map[usageKey]bool{}
	m.sent, m.sentAt = true, now
	return map[string]any{"buckets": list, "full": full, "launchers": true}, true
}

// startOffset finds where in a big file the window starts: lines are written in time order, so step back from the
// end until a line is older than the cutoff. Small files are read whole (lines before the cutoff are skipped anyway).
func startOffset(path string, size int64, cutoff time.Time) int64 {
	off, _ := startOffsetFrom(path, size, cutoff, 4<<20)
	return off
}

// startOffsetFrom is startOffset with files of up to small bytes read whole (the backfill's weeks take less); probed
// is what the search read (the backfill counts it against its rate).
func startOffsetFrom(path string, size int64, cutoff time.Time, small int64) (off, probed int64) {
	if size <= small {
		return 0, 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	buf := make([]byte, 256<<10)
	for step := small; ; step *= 2 {
		pos := size - step
		if pos <= 0 {
			return 0, probed
		}
		nr, _ := f.ReadAt(buf, pos)
		probed += int64(nr)
		chunk := buf[:nr]
		nl := bytes.IndexByte(chunk, '\n')
		if nl < 0 {
			continue // inside a long line: step further back
		}
		if ts := firstTime(chunk[nl+1:]); !ts.IsZero() && ts.Before(cutoff) {
			return pos + int64(nl) + 1, probed
		}
	}
}

// usageSessionState returns the recorded sessionState for a metered session id, falling back from a canonical
// agy-<conversation> id to a live or recent terminal pane row when the agy session ran in a pane.
func (n *Node) usageSessionState(session string) (sessionState, bool) {
	if n == nil || n.state == nil || session == "" {
		return sessionState{}, false
	}
	if st, ok := n.state.get(session); ok {
		return st, true
	}
	conv, ok := strings.CutPrefix(session, agyAgent+"-")
	if !ok || !uuidRe.MatchString(conv) {
		return sessionState{}, false
	}
	var bestID string
	var bestAt time.Time
	n.mu.Lock()
	for id, shown := range n.agyShown {
		if shown.conversation == conv && (bestID == "" || cmp.Or(shown.at.Compare(bestAt), strings.Compare(id, bestID)) > 0) {
			bestID, bestAt = id, shown.at
		}
	}
	n.mu.Unlock()
	if bestID != "" {
		return n.state.get(bestID)
	}
	return sessionState{}, false
}

// firstTime is the first "timestamp" (or agy's "created_at") value in b (escaped quotes inside messages do not match).
func firstTime(b []byte) time.Time {
	for _, key := range [][]byte{[]byte(`"timestamp":`), []byte(`"created_at":`)} {
		if t := firstTimeWithKey(b, key); !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

func firstTimeWithKey(b, key []byte) time.Time {
	i := bytes.Index(b, key)
	if i < 0 {
		return time.Time{}
	}
	rest := bytes.TrimLeft(b[i+len(key):], " \t")
	if len(rest) == 0 || rest[0] != '"' {
		return time.Time{}
	}
	rest = rest[1:]
	j := bytes.IndexByte(rest, '"')
	if j < 0 {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, string(rest[:j]))
	return t
}

// loadAverage is the 1-minute load average (0 when unknown). It uses sysmon's kernel read: the old path ran
// `sysctl -n vm.loadavg` and parsed its text, which under a decimal-comma locale (de_DE, fr_FR) made ParseFloat
// fail and the usage notification report a load of 0.
func loadAverage() float64 { return sysmon.LoadAverage() }
