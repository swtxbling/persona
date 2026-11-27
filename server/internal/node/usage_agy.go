package node

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Antigravity (agy) token usage adapter (docs/server/machines.md "Token usage"): agy writes per-step token counts
// (input_tokens exclusive of cache_read_tokens, output_tokens, cache_read_tokens, optional cache_write_tokens / nested
// usage) into <agy data root>/brain/<conversation>/.system_generated/logs/transcript.jsonl (or transcript_full.jsonl
// when only the full export exists). Metering from local files covers assistant chats, companion Agents, terminal pane
// Agents, standalone CLI sessions, subagent conversations, and backfill from one source of truth,
// while tokenuse.FileMetered("agy") rejects runtime usage.report duplicates.

var (
	agyPlannerMark    = []byte("PLANNER_RESPONSE")
	agyCheckpointMark = []byte("CHECKPOINT")
)

type agyUsage struct {
	node *Node
}

func (agyUsage) agent() string       { return agyAgent }
func (agyUsage) parser() usageParser { return &agyUsageParser{} }

// paths lists one transcript per real agy conversation directory under the node's agy data root: transcript.jsonl when
// present, else transcript_full.jsonl, so the same conversation is never scanned twice.
func (agyUsage) paths(n *Node, _ time.Time) []string {
	if n == nil || n.sessionScope != nil {
		return nil
	}
	var out []string
	seenRoots, seenPaths := map[string]bool{}, map[string]bool{}
	for _, root := range []string{n.agyDataRoot()} {
		if root == "" {
			continue
		}
		key := filepath.Clean(root)
		if real, err := filepath.EvalSymlinks(root); err == nil {
			key = real
		}
		if seenRoots[key] {
			continue
		}
		seenRoots[key] = true
		brain := filepath.Join(root, "brain")
		entries, err := os.ReadDir(brain)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !uuidRe.MatchString(entry.Name()) {
				continue
			}
			convDir := filepath.Join(brain, entry.Name())
			p := agyTranscriptFileForMeter(convDir)
			if p != "" && !seenPaths[p] {
				seenPaths[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

func agyTranscriptFileForMeter(convDir string) string {
	compact := filepath.Join(convDir, agyTranscriptPath)
	if st, err := os.Lstat(compact); err == nil {
		if st.Mode().IsRegular() {
			return compact
		}
		return ""
	} else if !os.IsNotExist(err) {
		return ""
	}
	full := filepath.Join(convDir, agyFullTranscriptPath)
	if st, err := os.Lstat(full); err == nil && st.Mode().IsRegular() {
		return full
	}
	return ""
}

// agyTranscriptRootAndID extracts the agy data root and conversation UUID from
// <root>/brain/<uuid>/.system_generated/logs/transcript*.jsonl.
func agyTranscriptRootAndID(path string) (rootDir, conversation string) {
	logs := filepath.Dir(path)
	if filepath.Base(logs) != "logs" {
		return "", ""
	}
	sysgen := filepath.Dir(logs)
	if filepath.Base(sysgen) != ".system_generated" {
		return "", ""
	}
	convDir := filepath.Dir(sysgen)
	conv := filepath.Base(convDir)
	if !uuidRe.MatchString(conv) {
		return "", ""
	}
	brain := filepath.Dir(convDir)
	if filepath.Base(brain) != "brain" {
		return "", ""
	}
	return filepath.Dir(brain), conv
}

// session returns the canonical agy-<conversation> session id (inheriting the owning parent conversation for built-in
// subagent transcripts so launcher and workspace attribution follow the parent).
func (agyUsage) session(path string) string {
	rootDir, conv := agyTranscriptRootAndID(path)
	if conv == "" {
		return ""
	}
	if parent := resolveAgySubagentParent(rootDir, conv); parent != "" {
		conv = parent
	}
	return agyAgent + "-" + conv
}

// startDir resolves a conversation's workspace directory from agy's conversation_summaries.db workspace_uris
// (inheriting the owning parent's workspace for subagent conversations).
func (a agyUsage) startDir(path string) string {
	rootDir, conv := agyTranscriptRootAndID(path)
	if rootDir == "" || conv == "" {
		return ""
	}
	if parent := resolveAgySubagentParent(rootDir, conv); parent != "" {
		if dir := a.lookupSummaryDir(rootDir, parent); dir != "" {
			return dir
		}
	}
	return a.lookupSummaryDir(rootDir, conv)
}

func (a agyUsage) lookupSummaryDir(rootDir, conv string) string {
	if a.node == nil {
		return ""
	}
	return a.node.agyUsageDirs.dirOf(rootDir, conv)
}

type agySummaryDirEntry struct {
	stamp string
	dirs  map[string]string
}

type agySummaryDirCache struct {
	mu     sync.Mutex
	byRoot map[string]agySummaryDirEntry
}

func (c *agySummaryDirCache) dirOf(rootDir, conv string) string {
	dbPath := filepath.Join(rootDir, "conversation_summaries.db")
	if _, err := os.Stat(dbPath); err != nil {
		return ""
	}
	stamp := fileStamp(dbPath) + fileStamp(dbPath+"-wal")
	c.mu.Lock()
	if e, ok := c.byRoot[dbPath]; ok && e.stamp == stamp {
		dir := e.dirs[conv]
		c.mu.Unlock()
		return dir
	}
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var rows []struct {
		ID            string `json:"conversation_id"`
		WorkspaceURIs string `json:"workspace_uris"`
	}
	if querySQLite(ctx, dbPath, `SELECT conversation_id, coalesce(workspace_uris, '') AS workspace_uris FROM conversation_summaries`, &rows) != nil {
		return ""
	}
	dirs := make(map[string]string, len(rows))
	for _, r := range rows {
		if dir := agyFirstWorkspaceDir(r.WorkspaceURIs); dir != "" {
			dirs[r.ID] = dir
		}
	}
	c.mu.Lock()
	if c.byRoot == nil {
		c.byRoot = map[string]agySummaryDirEntry{}
	}
	c.byRoot[dbPath] = agySummaryDirEntry{stamp: stamp, dirs: dirs}
	c.mu.Unlock()
	return dirs[conv]
}

func agyFirstWorkspaceDir(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var uris []string
	if json.Unmarshal([]byte(raw), &uris) != nil {
		return ""
	}
	for _, u := range uris {
		if p := agyWorkspaceURIToPath(u); p != "" {
			return p
		}
	}
	return ""
}

func agyWorkspaceURIToPath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(raw), "file://") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "file" || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) {
			return ""
		}
		p := u.Path
		if unesc, err := url.PathUnescape(p); err == nil {
			p = unesc
		}
		if len(p) >= 3 && p[0] == '/' && ((p[1] >= 'A' && p[1] <= 'Z') || (p[1] >= 'a' && p[1] <= 'z')) && p[2] == ':' {
			p = p[1:]
		}
		raw = p
	}
	if strings.ContainsRune(raw, 0) || !filepath.IsAbs(raw) {
		return ""
	}
	return filepath.Clean(raw)
}

type agyUsageLine struct {
	Index                    *int          `json:"step_index"`
	Type                     string        `json:"type"`
	CreatedAt                string        `json:"created_at"`
	UpdatedAt                string        `json:"updated_at"`
	Model                    string        `json:"model"`
	InputTokens              int64         `json:"input_tokens"`
	OutputTokens             int64         `json:"output_tokens"`
	CacheReadTokens          int64         `json:"cache_read_tokens"`
	CacheReadInputTokens     int64         `json:"cache_read_input_tokens"`
	CacheWriteTokens         int64         `json:"cache_write_tokens"`
	CacheCreationInputTokens int64         `json:"cache_creation_input_tokens"`
	CacheWrite1hTokens       int64         `json:"cache_write_1h_tokens"`
	Usage                    *agyStepUsage `json:"usage"`
}

// agyUsageParser reads an Antigravity JSONL transcript line by line. Same-step streaming refreshes (same step_index,
// type and created_at) emit only their positive monotonic delta with more=true (never double-counting or producing
// negative counts); rewinds carry a new created_at and count as new requests; cross-file keys fingerprint the step's
// model and token tuple so forks deduplicate while concurrent conversations in the same second with distinct model or
// token counts both count (identical tuples in the same second deduplicate to preserve fork idempotency). Lines without
// a non-negative step_index carry a deterministic content-derived key so rewrites never double-count them.
type agyUsageParser struct {
	model string
	steps map[string]usageTokens
}

func (p *agyUsageParser) line(line []byte) (usageRecord, bool) {
	if !bytes.Contains(line, agyPlannerMark) && !bytes.Contains(line, agyCheckpointMark) {
		return usageRecord{}, false
	}
	var l agyUsageLine
	if json.Unmarshal(line, &l) != nil {
		return usageRecord{}, false
	}
	if l.Type != "PLANNER_RESPONSE" && l.Type != "CHECKPOINT" {
		return usageRecord{}, false
	}
	rawModel := strings.TrimSpace(l.Model)
	if isBracketedModel(rawModel) {
		return usageRecord{}, false
	}
	if l.Type == "PLANNER_RESPONSE" && rawModel != "" {
		p.model = rawModel
	}
	model := rawModel
	if model == "" {
		model = p.model
	}
	in, out, cr, cw, _, ok := extractAgyStepTokens(
		l.InputTokens, l.OutputTokens,
		l.CacheReadTokens, l.CacheReadInputTokens,
		l.CacheWriteTokens, l.CacheCreationInputTokens,
		l.CacheWrite1hTokens, l.Usage,
	)
	if !ok {
		return usageRecord{}, false
	}
	ts := parseAgyStepTime(l.CreatedAt, l.UpdatedAt)
	if ts.IsZero() {
		return usageRecord{}, false
	}
	got := usageTokens{input: in, output: out, cacheRead: cr, cacheWrite: cw}
	normTS := ts.UTC().Format(time.RFC3339Nano)
	tokenSuffix := ":" + rawModel + ":" +
		strconv.FormatInt(in, 10) + ":" + strconv.FormatInt(out, 10) + ":" +
		strconv.FormatInt(cr, 10) + ":" + strconv.FormatInt(cw, 10)
	if l.Index == nil || *l.Index < 0 {
		key := "agy:noindex:" + l.Type + ":" + normTS + tokenSuffix
		return usageRecord{time: ts, agent: agyAgent, model: model, key: key, tokens: got}, true
	}
	stepID := strconv.Itoa(*l.Index) + ":" + l.Type + ":" + normTS
	key := "agy:" + stepID + tokenSuffix
	if p.steps == nil {
		p.steps = map[string]usageTokens{}
	}
	prev, seen := p.steps[stepID]
	if !seen {
		p.steps[stepID] = got
		return usageRecord{time: ts, agent: agyAgent, model: model, key: key, parentKey: stepID, tokens: got}, true
	}
	delta := usageTokens{
		input:      max(got.input-prev.input, 0),
		output:     max(got.output-prev.output, 0),
		cacheRead:  max(got.cacheRead-prev.cacheRead, 0),
		cacheWrite: max(got.cacheWrite-prev.cacheWrite, 0),
	}
	if delta.zero() {
		return usageRecord{}, false
	}
	p.steps[stepID] = usageTokens{
		input:      max(prev.input, got.input),
		output:     max(prev.output, got.output),
		cacheRead:  max(prev.cacheRead, got.cacheRead),
		cacheWrite: max(prev.cacheWrite, got.cacheWrite),
	}
	return usageRecord{time: ts, agent: agyAgent, model: model, key: key, parentKey: stepID, more: true, tokens: delta}, true
}

func parseAgyStepTime(created, updated string) time.Time {
	for _, raw := range []string{created, updated} {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339Nano, raw); err == nil && !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}
