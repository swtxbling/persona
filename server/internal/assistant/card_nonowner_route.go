package assistant

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/nwverse/persona/server/internal/assistantwire"
	"github.com/nwverse/persona/server/internal/proto"
)

// nonOwnerCardTarget resolves who handles a non-six-class card instead of pushing it to the owner:
// the task's supervisor when the session belongs to an open supervised to-do, otherwise the main
// conversation (or the background supervisor when the main conversation itself raised the card).
// Returns ("", false) when neither a supervisor nor a main conversation is configured.
func (s *Service) nonOwnerCardTarget(ctx context.Context, machine, sessionID string) (string, bool) {
	cfg := s.settings(ctx)
	if machine != "" && sessionID != "" {
		canon := machine
		if s.devs != nil {
			canon = s.devs.Canonical(machine)
		}
		if t, ok := s.todoOfSession(ctx, canon, sessionID); ok && t.Supervision != nil {
			switch t.Supervision.state(t) {
			case reviewAccepted, reviewCancelled:
			default:
				if sup := s.effectiveSupervisor(ctx, cfg, t); sup != "" && sup != sessionID {
					return sup, true
				}
			}
		}
	}
	if cfg.Main == "" {
		return "", false
	}
	if sessionID == cfg.Main && cfg.BackgroundSupervisor != "" && cfg.BackgroundSupervisor != cfg.Main {
		return cfg.BackgroundSupervisor, true
	}
	return cfg.Main, true
}

// scheduleFailureTarget resolves who handles a failed scheduled run instead of pushing it to the
// owner: the supervisor of the task's originating session (if any), the originating leader/main
// conversation itself, or the main conversation. Returns ("", false) when none is configured.
func (s *Service) scheduleFailureTarget(ctx context.Context, t Task) (string, bool) {
	cfg := s.settings(ctx)
	if t.SessionID != "" {
		machine := cmp.Or(t.MachineID, cfg.MachineID)
		if machine != "" {
			canon := machine
			if s.devs != nil {
				canon = s.devs.Canonical(machine)
			}
			if td, ok := s.todoOfSession(ctx, canon, t.SessionID); ok && td.Supervision != nil {
				switch td.Supervision.state(td) {
				case reviewAccepted, reviewCancelled:
				default:
					if sup := s.effectiveSupervisor(ctx, cfg, td); sup != "" {
						return sup, true
					}
				}
			}
		}
		if t.SessionID == cfg.Main || slices.Contains(cfg.Leaders, t.SessionID) {
			return t.SessionID, true
		}
	}
	if cfg.Main != "" {
		return cfg.Main, true
	}
	return "", false
}

// presentHeldNonOwnerCard puts a non-six-class card on the owner's Needs you list without an immediate alert. The
// interaction itself carries P1 as well as the notification, so the hub's state projection and its push grading agree.
// heldAnnounced prevents the channels' catch-up from turning the held card into a second, owner-facing card.
func (s *Service) presentHeldNonOwnerCard(ix proto.Interaction, src string) {
	ix.Delegating = false
	ix.PushLevel = assistantwire.LevelP1
	shown := s.tellApps(ix)
	s.recordConfirmationNotification(shown)
	s.heldAnnounced(shown.ID)
	s.deliverCard(src, Notification{
		Kind: assistantwire.NotifyInput, DeviceID: shown.MachineID, Subtitle: s.machineName(shown.MachineID),
		SessionID: shown.SessionID, Interaction: &shown, Level: assistantwire.LevelP1, RelatedKey: "ix:" + shown.ID,
	})
}

// handNonOwnerCard intercepts every interaction card whose source is outside the owner's six classes and was not
// already handled by ask_route or delegable. This includes agent permissions and questions, the manager's tool
// permissions, device control and extension approvals. The card remains pending and answerable: its route is parked
// with the supervisor/main conversation, while quiet or grading mode additionally exposes it through tellApps as P1.
//
// Owner-only forms, secrets, outward writes, paid or irreversible actions, explicit delegate context and user-only
// terminal dialogs return false, preserving the ordinary P0 owner path. A supervising conversation's own card is never
// handed to itself or another supervisor; with grading on it is still shown directly to the owner as a held P1 card.
func (s *Service) handNonOwnerCard(ix proto.Interaction) bool {
	src := s.inputCardSource(ix, false)
	if cardCategoryOf(src) != cardCatNone {
		return false
	}
	if ix.Delegate != nil || userApproval(ix) != "" {
		return false
	}
	if ix.Kind == proto.IxScreen && (!supervisedScreen(ix) || userScreen(ix) != "") {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	held := s.nonOwnerCardPushHeld(ctx)
	cfg := s.settings(ctx)
	to, routed := "", false
	if !cfg.supervisorConversation(ix.SessionID) {
		to, routed = s.nonOwnerCardTarget(ctx, ix.MachineID, ix.SessionID)
		// Never let a malformed or stale route point back at its source.
		if to == ix.SessionID {
			to, routed = "", false
		}
	}
	if !routed && !held {
		return false // With both switches off, an unrouteable card keeps its legacy owner delivery.
	}
	home := cfg.MachineID
	if s.devs != nil && home != "" {
		home = s.devs.Canonical(home)
	}

	s.fleet.mu.Lock()
	p := s.fleet.interactions[ix.ID]
	if p == nil || p.claimed || p.told || !p.ix.CreatedAt.Equal(ix.CreatedAt) {
		s.fleet.mu.Unlock()
		return false
	}
	now := time.Now()
	if routed {
		// Parked at askRemindMax with empty todo so askTick never emits a todo-less sigAsk or rings
		// the owner on timeout, while routedTo still lets the target or main conversation answer it.
		p.route = &askRoute{
			machine:   home,
			ladder:    []string{to},
			routedAt:  now,
			since:     now,
			held:      now,
			parked:    true,
			reminders: askRemindMax,
		}
	}
	p.ix.Delegating = routed && !held
	if held {
		p.ix.PushLevel = assistantwire.LevelP1
	}
	s.fleet.mu.Unlock()

	if held {
		s.presentHeldNonOwnerCard(ix, src)
	} else {
		shown := ix
		shown.Delegating = true
		s.show(shown)
	}
	if !routed {
		return true
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Non-owner card (%s) routed to you; the owner has no immediate alert.\n", src)
	fmt.Fprintf(&b, "interaction_id=%s kind=%s", ix.ID, ix.Kind)
	if ix.MachineID != "" {
		fmt.Fprintf(&b, " machine=%s", ix.MachineID)
	}
	if ix.SessionID != "" {
		fmt.Fprintf(&b, " session_id=%s", ix.SessionID)
	}
	if ix.ToolName != "" {
		fmt.Fprintf(&b, " tool=%s", ix.ToolName)
	}
	if ask := clip(oneLine(noticeAsk(ix)), 300); ask != "" {
		fmt.Fprintf(&b, "\n%s", ask)
	}
	title := cmp.Or(ix.SessionTitle, ix.ToolName, src)
	if _, kept := s.keepRelayLater(to, relayMsg{
		From:      src,
		FromTitle: title,
		Tool:      src,
		Text:      b.String(),
		At:        now.UTC(),
	}); kept {
		s.publish(ctx)
	}
	s.workEvent(ix.MachineID, ix.SessionID, "ask_routed_nonowner", map[string]any{
		"to": to, "source": src, "kind": ix.Kind, "id": ix.ID, "held": held,
	})
	return true
}
