package transcript

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"weak"

	"github.com/nwverse/persona/server/internal/proto"
)

func assertFileTreeDropsRaw(t *testing.T, label string, f *File) {
	t.Helper()
	if f.tree == nil || len(f.tree.recs) == 0 {
		t.Fatalf("%s: expected populated File.tree.recs", label)
	}
	for i, rec := range f.tree.recs {
		if rec.raw != nil || cap(rec.raw) != 0 {
			t.Fatalf("%s: f.tree.recs[%d] (uuid=%q) retained raw buffer (len=%d cap=%d)", label, i, rec.uuid, len(rec.raw), cap(rec.raw))
		}
	}
	if f.meta.tree.raw != nil || cap(f.meta.tree.raw) != 0 {
		t.Fatalf("%s: f.meta.tree.raw retained raw buffer (len=%d cap=%d)", label, len(f.meta.tree.raw), cap(f.meta.tree.raw))
	}
}

func TestFileTreeDoesNotRetainRawLines(t *testing.T) {
	t.Run("refresh_and_append", func(t *testing.T) {
		l := &tline{}
		l.user("u1", "", "first question", 1)
		l.toolUse("a1", "u1", "tu1", 2)
		l.toolResult("r1", "a1", "tu1", "tool output", 3)
		l.reply("a2", "r1", "first answer", 4)
		l.turnEnd("t1", "a2", 5)
		l.user("u2", "t1", "old branch question", 6)
		l.reply("a3", "u2", "old branch answer", 7)
		l.turnEnd("t2", "a3", 8)

		p := writeLines(t, l)
		f := NewFile(p)
		if _, _, err := f.RefreshSpan(); err != nil {
			t.Fatal(err)
		}
		assertFileTreeDropsRaw(t, "initial refresh", f)

		more := &tline{}
		more.user("u3", "t1", "replacement question", 9)
		more.reply("a4", "u3", "replacement answer", 10)
		more.turnEnd("t3", "a4", 11)
		appendLines(t, p, more)

		_, span, err := f.RefreshSpan()
		if err != nil {
			t.Fatal(err)
		}
		assertFileTreeDropsRaw(t, "append refresh", f)
		if !strings.HasSuffix(span.History, ".r1") {
			t.Fatalf("history = %q, want .r1 suffix", span.History)
		}
		want(t, allItems(f), "first question", "first answer", "replacement question", "replacement answer")
	})

	t.Run("window_paging_navigation_and_meta", func(t *testing.T) {
		old := windowBytes
		windowBytes = 2 << 10
		t.Cleanup(func() { windowBytes = old })

		pad := strings.Repeat("padding ", 128)
		l := &tline{}
		l.user("u1", "", "early question", 1)
		l.reply("a1", "u1", "early answer", 2)
		l.turnEnd("t1", "a1", 3)
		l.user("u2", "t1", "abandoned question", 4)
		l.reply("a2", "u2", "abandoned answer", 5)
		l.turnEnd("t2", "a2", 6)
		for i := range 12 {
			l.add(fmt.Sprintf(`{"type":"assistant","uuid":"pad%d","parentUuid":"t2","timestamp":"2026-11-05T10:01:%02dZ","message":{"role":"assistant","content":[{"type":"thinking","thinking":%q}]}}`, i, i, pad))
		}
		l.user("u3", "t1", "kept replacement", 100)
		l.reply("a3", "u3", "kept answer", 101)
		l.turnEnd("t3", "a3", 102)
		for i := range 4 {
			l.add(fmt.Sprintf(`{"type":"assistant","uuid":"tail%d","parentUuid":"t3","timestamp":"2026-11-05T10:03:%02dZ","message":{"role":"assistant","content":[{"type":"thinking","thinking":%q}]}}`, i, i, pad))
		}
		l.user("u4", "t3", "latest question", 200)
		l.reply("a4", "u4", "latest answer", 201)
		l.turnEnd("t4", "a4", 202)

		p := filepath.Join(t.TempDir(), "windowed.jsonl")
		if err := os.WriteFile(p, []byte(l.b.String()), 0o600); err != nil {
			t.Fatal(err)
		}

		// Cold open + Meta() (fullMeta/parseRange) + navigation + paging through loadOlder.
		f := NewFile(p)
		if _, _, err := f.RefreshSpan(); err != nil {
			t.Fatal(err)
		}
		if f.base == 0 || f.win == nil {
			t.Fatalf("expected windowed cold open, got base=%d win=%v", f.base, f.win)
		}
		assertFileTreeDropsRaw(t, "openWindow", f)

		_ = f.Meta()
		assertFileTreeDropsRaw(t, "fullMeta", f)

		compact, err := f.CompactUserInputs(t.Context(), 0)
		if err != nil {
			t.Fatal(err)
		}
		if compact.Total != 3 || !strings.HasSuffix(compact.History, ".r1") {
			t.Fatalf("compact inputs = %+v, want total=3 with .r1 history", compact)
		}
		assertFileTreeDropsRaw(t, "CompactUserInputs", f)

		win, err := f.ItemsWindow(t.Context(), proto.ItemsWindowRequest{FromSeq: 1, ThroughSeq: 6})
		if err != nil || len(win.Items) != 3 || win.Items[0].ID != "u1#0" || win.Items[1].ID != "a1#0" || win.Items[2].ID != "t1#0" {
			t.Fatalf("ItemsWindow(1..6) = %+v, %v", win, err)
		}

		// Also exercise loadOlder without coldInputs (ordinary Page/PageTurns backfill) so branchTree.prepend runs.
		g := NewFile(p)
		if _, _, err := g.RefreshSpan(); err != nil {
			t.Fatal(err)
		}
		if g.base == 0 {
			t.Fatalf("expected windowed cold open for g")
		}
		assertFileTreeDropsRaw(t, "g openWindow", g)

		for before := 0; ; {
			items, more, _ := g.Page(before, 2)
			assertFileTreeDropsRaw(t, fmt.Sprintf("g Page(before=%d)", before), g)
			if !more || len(items) == 0 {
				break
			}
			before = items[0].Seq
		}
		if g.base != 0 {
			t.Fatalf("expected g to page back to line 1, got base=%d", g.base)
		}
		assertFileTreeDropsRaw(t, "g after full paging", g)
		want(t, allItems(g), "early question", "early answer", "kept replacement", "kept answer", "latest question", "latest answer")

		if _, ok := g.RewoundAt("u4"); !ok {
			t.Fatal("RewoundAt(u4) failed")
		}
		want(t, allItems(g), "early question", "early answer", "kept replacement", "kept answer")
		assertFileTreeDropsRaw(t, "g after RewoundAt", g)
	})
}

//go:noinline
func parseWindowBufferForWeakCheck(f *File, meta *Meta, kept, sent *[]proto.Item) weak.Pointer[byte] {
	pad := strings.Repeat("x", 512<<10)
	var b strings.Builder
	b.WriteString(`{"type":"user","uuid":"u1","timestamp":"2026-11-05T10:00:00Z","message":{"role":"user","content":"hello"}}` + "\n")
	fmt.Fprintf(&b, `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-11-05T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"echo ok"}},{"type":"text","text":"done"}]}}`+"\n")
	fmt.Fprintf(&b, `{"type":"user","uuid":"r1","parentUuid":"a1","timestamp":"2026-11-05T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":%q}]}}`+"\n", pad)
	b.WriteString(`{"type":"system","subtype":"turn_duration","uuid":"t1","parentUuid":"r1","durationMs":1200,"timestamp":"2026-11-05T10:00:03Z"}` + "\n")
	buf := []byte(b.String())
	f.parseLines(buf, 0, 1, meta, f.tree, kept, sent)
	return weak.Make(&buf[0])
}

func TestFileParseLinesReleasesBackingBuffer(t *testing.T) {
	f := NewFile("synthetic.jsonl")
	f.tree = &branchTree{}
	var meta Meta
	var kept, sent []proto.Item

	wp := parseWindowBufferForWeakCheck(f, &meta, &kept, &sent)
	if len(f.tree.recs) != 4 {
		t.Fatalf("got %d tree recs, want 4", len(f.tree.recs))
	}
	runtime.GC()
	runtime.GC()
	if wp.Value() != nil {
		t.Error("File.parseLines retained a pointer into the parsed backing buffer")
	}
	assertFileTreeDropsRaw(t, "parseLines", f)

	runtime.KeepAlive(f)
	runtime.KeepAlive(&meta)
	runtime.KeepAlive(kept)
	runtime.KeepAlive(sent)
}

func TestTailRetainsRawForSettleWhileFileDropsIt(t *testing.T) {
	const failure = "API Error: 529 Overloaded"
	lines := []string{
		prompt("u1", "A"),
		apiErrorLine(t, "e1", failure, map[string]any{"error": "server_error"}),
		turnEndLine,
		prompt("ub", "B"),
		`{"type":"assistant","uuid":"b","parentUuid":"ub","timestamp":"2026-01-01T12:00:00Z","message":{"id":"mb","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"B succeeded"}]}}`,
		strings.Replace(strings.Replace(turnEndLine, `"uuid":"d"`, `"uuid":"db"`, 1), `"parentUuid":"x"`, `"parentUuid":"b"`, 1),
	}

	// File path: drops raw on tree recs while preserving rewind/branch semantics.
	p := filepath.Join(t.TempDir(), "tail-vs-file.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := NewFile(p)
	if _, _, err := f.RefreshSpan(); err != nil {
		t.Fatal(err)
	}
	assertFileTreeDropsRaw(t, "file before rewind", f)
	span, ok := f.RewoundAt("ub")
	if !ok || !strings.HasSuffix(span.History, ".r1") {
		t.Fatalf("File.RewoundAt(ub) = %+v, %v", span, ok)
	}
	rewound := f.RewoundLines()
	if len(rewound) != 3 {
		t.Fatalf("RewoundLines() = %v, want 3 lines", rewound)
	}
	assertFileTreeDropsRaw(t, "file after rewind", f)

	// Tail path: retains raw on tree recs so Settle replays visible turn error/state (including Skipped lines).
	var m Meta
	var tail Tail
	tail.Rewound(rewound)
	for i, line := range lines {
		tail.Line(&m, ParseLine(i+1, []byte(line), &m))
	}
	bigToolResult := `{"type":"user","uuid":"big","parentUuid":"db","timestamp":"2026-01-01T12:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"` + strings.Repeat("A", 16<<10) + `"}]},"toolUseResult":{"stdout":"` + strings.Repeat("A", 16<<10) + `"}}`
	tail.Skipped([]byte(bigToolResult))
	if len(tail.tree.recs) != len(lines)+1 {
		t.Fatalf("tail recs = %d, want %d", len(tail.tree.recs), len(lines)+1)
	}
	for i, rec := range tail.tree.recs {
		if len(rec.raw) == 0 {
			t.Fatalf("tail.tree.recs[%d] (uuid=%q) unexpectedly dropped raw", i, rec.uuid)
		}
	}
	if !tail.Settle(&m) {
		t.Fatal("Tail.Settle returned false, want true")
	}
	if m.TurnError != failure || m.TurnSucceeded() || !m.TurnClosed || m.LastText != failure {
		t.Fatalf("Tail.Settle state = error:%q succeeded:%v closed:%v last:%q", m.TurnError, m.TurnSucceeded(), m.TurnClosed, m.LastText)
	}
}
