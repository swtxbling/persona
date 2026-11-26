import Foundation
import PersonaKit
import PersonaWire
import SwiftUI
import Testing
import UIKit
@testable import Persona

/// Regression tests reproducing and verifying fixes for:
/// 1. Message list jumps caused by bottom queue panels/drawers, action-bar trays, and uncompensated footer height changes.
/// 2. Sudden layout/screen jumps when creating a New Main Chat (`startNewMain` bypassing `MainClearState`).
@MainActor
@Suite(.serialized)
struct ChatQueueAndTrayJumpRegressionTests {
    private final class MeasuredHeights {
        var transcript: CGFloat = 0
        var footer: CGFloat = 0
    }

    private struct MeasuredChatStack<Footer: View>: View {
        let heights: MeasuredHeights
        @ViewBuilder let footer: () -> Footer

        var body: some View {
            VStack(spacing: 0) {
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights.transcript = $0 }
                footer()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights.footer = $0 }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private struct ComposerQueuedHost: View {
        let model: AppModel
        let key: SessionKey
        let heights: MeasuredHeights
        @State private var text = ""
        @State private var selection: TextSelection?
        @FocusState private var focused: Bool

        var body: some View {
            MeasuredChatStack(heights: heights) {
                ShellComposerBar(
                    placeholder: "Ask Persona",
                    text: $text,
                    selection: $selection,
                    focused: $focused,
                    canSend: false,
                    send: {},
                    attach: { EmptyView() },
                    modes: { EmptyView() },
                    top: { ComposerTopSlot(key: key) }
                )
                .padding(.horizontal, Theme.Space.m)
                .padding(.bottom, Theme.Space.s)
            }
            .environment(model)
        }
    }

    private func setAccessibilityAutomation(_ enabled: Bool) throws {
        let handle = try #require(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW))
        let symbol = try #require(dlsym(handle, "_AXSSetAutomationEnabled"))
        typealias Enable = @convention(c) (Int32) -> Void
        unsafeBitCast(symbol, to: Enable.self)(enabled ? 1 : 0)
    }

    private func makeWindow() throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        return window
    }

    private func waitForElement(id: String, timeoutMs: Int = 3000) async -> NSObject? {
        let steps = max(1, timeoutMs / 50)
        for _ in 0..<steps {
            if let found = RuntimeCLI.elements(matching: ["id": id]).first?.object {
                return found
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return nil
    }

    private func settle(_ window: UIWindow) async {
        for _ in 0..<6 {
            window.layoutIfNeeded()
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func makeSession(key: SessionKey, queued: [String], status: String = "working") throws -> Session {
        let payload: [String: Any] = [
            "machine_id": key.machineID,
            "session_id": key.sessionID,
            "title": "Main Chat",
            "cwd": "/workspace/project",
            "status": status,
            "state": status,
            "assistant": true,
            "can_send": true,
            "queued": queued,
        ]
        return try JSON.decoder.decode(Session.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func actionBarTraysFloatWithoutShiftingTranscriptHeight() async throws {
        try setAccessibilityAutomation(true)
        defer { try? setAccessibilityAutomation(false) }

        let key = SessionKey(machineID: "box", sessionID: "conv-jump")
        let heights = MeasuredHeights()
        let window = try makeWindow()
        defer { window.isHidden = true }

        window.rootViewController = UIHostingController(rootView: MeasuredChatStack(heights: heights) {
            AssistantActionBar(conversation: "conv-jump", key: key)
                .padding(.horizontal, Theme.Space.m)
                .padding(.bottom, Theme.Space.s)
        })
        window.isHidden = false
        await settle(window)

        let baselineTranscript = heights.transcript
        let baselineFooter = heights.footer
        #expect(baselineTranscript > 400)
        #expect(baselineFooter > 0)

        let needsButton = try #require(await waitForElement(id: "action-bar.needs-you"))
        #expect(needsButton.accessibilityActivate())
        await settle(window)

        let boardButtonInNeeds = try #require(await waitForElement(id: "action-tray.board"),
                                              "Needs You tray content must appear when toggled open")
        #expect(boardButtonInNeeds.accessibilityFrame.maxY <= needsButton.accessibilityFrame.minY + 1,
                "Floating Needs You tray (\(boardButtonInNeeds.accessibilityFrame)) must float strictly above the action bar (\(needsButton.accessibilityFrame))")
        #expect(abs(heights.transcript - baselineTranscript) < 0.5,
                "Opening Needs You tray shifted transcript height from \(baselineTranscript) to \(heights.transcript)")
        #expect(abs(heights.footer - baselineFooter) < 0.5,
                "Opening Needs You tray changed action bar layout height from \(baselineFooter) to \(heights.footer)")

        let runningButton = try #require(await waitForElement(id: "action-bar.running"))
        #expect(runningButton.accessibilityActivate())
        await settle(window)

        let boardButtonInRunning = try #require(await waitForElement(id: "action-tray.board"),
                                                "In Progress tray content must appear when toggled open")
        #expect(boardButtonInRunning.accessibilityFrame.maxY <= runningButton.accessibilityFrame.minY + 1,
                "Floating In Progress tray (\(boardButtonInRunning.accessibilityFrame)) must float strictly above the action bar (\(runningButton.accessibilityFrame))")
        #expect(abs(heights.transcript - baselineTranscript) < 0.5,
                "Switching to In Progress tray shifted transcript height from \(baselineTranscript) to \(heights.transcript)")
        #expect(abs(heights.footer - baselineFooter) < 0.5,
                "Switching to In Progress tray changed action bar layout height from \(baselineFooter) to \(heights.footer)")

        #expect(runningButton.accessibilityActivate())
        await settle(window)
        #expect(abs(heights.transcript - baselineTranscript) < 0.5,
                "Closing tray shifted transcript height from \(baselineTranscript) to \(heights.transcript)")
    }

    @Observable final class QueueStripBox {
        var queued: [String]
        init(_ queued: [String]) { self.queued = queued }
    }

    private struct QueueStripHost: View {
        let model: AppModel
        let key: SessionKey
        let box: QueueStripBox
        let heights: MeasuredHeights

        var body: some View {
            MeasuredChatStack(heights: heights) {
                QueueStrip(key: key, queued: box.queued, own: box.queued.count, steers: true)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.bottom, Theme.Space.s)
            }
            .environment(model)
        }
    }

    @Test func queueStripKeepsTranscriptStableWhenExpandedAndCountChanges() async throws {
        try setAccessibilityAutomation(true)
        defer { try? setAccessibilityAutomation(false) }

        let model = AppModel(stateFolder: FileManager.default.temporaryDirectory.appending(path: "queue-strip-jump-" + UUID().uuidString))
        let key = SessionKey(machineID: "box", sessionID: "agent-queue-jump")
        let box = QueueStripBox(["First queued task"])
        let heights = MeasuredHeights()
        let window = try makeWindow()
        defer { window.isHidden = true }

        window.rootViewController = UIHostingController(rootView: QueueStripHost(model: model, key: key, box: box, heights: heights))
        window.isHidden = false
        await settle(window)

        let collapsedTranscript = heights.transcript
        let collapsedFooter = heights.footer
        #expect(collapsedTranscript > 400)
        #expect(collapsedFooter > 0)

        let strip = try #require(await waitForElement(id: "queue-strip"))
        let stripTopBefore = strip.accessibilityFrame.minY
        #expect(strip.accessibilityActivate())
        await settle(window)

        let item = try #require(await waitForElement(id: "queue-item"),
                                "Expanded QueueStrip must expose queued items")
        #expect(item.accessibilityFrame.maxY <= stripTopBefore + 1,
                "Floating QueueStrip drawer (\(item.accessibilityFrame)) must float strictly above the collapsed card top (\(stripTopBefore))")
        #expect(abs(heights.transcript - collapsedTranscript) < 0.5,
                "Expanding QueueStrip shifted transcript height from \(collapsedTranscript) to \(heights.transcript)")
        #expect(abs(heights.footer - collapsedFooter) < 0.5,
                "Expanding QueueStrip changed card height from \(collapsedFooter) to \(heights.footer)")

        for count in [3, 5, 1] {
            box.queued = (1...count).map { "Queued agent step #\($0)" }
            await settle(window)
            #expect(abs(heights.transcript - collapsedTranscript) < 0.5,
                    "Changing QueueStrip count to \(count) shifted transcript height from \(collapsedTranscript) to \(heights.transcript)")
        }
    }

    @Test func composerQueuedTopKeepsTranscriptStableAcrossExpandAndCountChanges() async throws {
        try setAccessibilityAutomation(true)
        defer { try? setAccessibilityAutomation(false) }

        let model = AppModel(stateFolder: FileManager.default.temporaryDirectory.appending(path: "queue-jump-" + UUID().uuidString))
        let key = SessionKey(machineID: "box", sessionID: "main-queue-jump")
        let machine = MachineRef(group: "", id: "box")
        model.applySessions([machine: [try makeSession(key: key, queued: ["First queued message"])]])

        let heights = MeasuredHeights()
        let window = try makeWindow()
        defer { window.isHidden = true }

        window.rootViewController = UIHostingController(rootView: ComposerQueuedHost(model: model, key: key, heights: heights))
        window.isHidden = false
        await settle(window)

        let collapsedTranscript = heights.transcript
        let collapsedFooter = heights.footer
        #expect(collapsedTranscript > 400)
        #expect(collapsedFooter > 0)

        let toggle = try #require(await waitForElement(id: "queue-strip.toggle"))
        #expect(toggle.accessibilityActivate())
        await settle(window)

        let firstItem = try #require(await waitForElement(id: "queue-item"),
                                     "Expanded queue drawer must expose queue items")
        #expect(firstItem.accessibilityFrame.maxY <= toggle.accessibilityFrame.minY + 1,
                "Floating ComposerQueuedTop drawer (\(firstItem.accessibilityFrame)) must float strictly above the header (\(toggle.accessibilityFrame))")
        #expect(abs(heights.transcript - collapsedTranscript) < 0.5,
                "Expanding ComposerQueuedTop shifted transcript height from \(collapsedTranscript) to \(heights.transcript)")
        #expect(abs(heights.footer - collapsedFooter) < 0.5,
                "Expanding ComposerQueuedTop changed composer layout height from \(collapsedFooter) to \(heights.footer)")

        // Changing queued count 1 -> 2 -> 5 -> 1 while expanded must never move the transcript.
        for count in [2, 5, 1] {
            let messages = (1...count).map { "Queued follow-up #\($0)" }
            model.applySessions([machine: [try makeSession(key: key, queued: messages)]])
            await settle(window)
            #expect(abs(heights.transcript - collapsedTranscript) < 0.5,
                    "Changing expanded queue count to \(count) shifted transcript height from \(collapsedTranscript) to \(heights.transcript)")
        }

        // Collapse again and verify zero shift.
        let collapseToggle = try #require(await waitForElement(id: "queue-strip.toggle"))
        #expect(collapseToggle.accessibilityActivate())
        await settle(window)
        #expect(abs(heights.transcript - collapsedTranscript) < 0.5,
                "Collapsing ComposerQueuedTop shifted transcript height from \(collapsedTranscript) to \(heights.transcript)")
    }

    @Test func chatPinCompensatesFooterResizeWithoutPinnedHeader() {
        let list = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        list.contentInsetAdjustmentBehavior = .never
        list.contentSize = CGSize(width: 320, height: 2400)
        list.contentInset = UIEdgeInsets(top: 80, left: 0, bottom: 100, right: 0)
        let pin = ChatPin()
        pin.list = list

        // Reading history with no pinned work-line header: queue bar appearing (0 -> 1, +30.5 pt footer -> -30.5 edge delta)
        // and draining (1 -> 0, +30.5 edge delta) must adjust contentOffset so visible rows stay fixed on screen.
        list.contentOffset = CGPoint(x: 0, y: 500)
        pin.resized(by: -30.5)
        #expect(abs(list.contentOffset.y - 530.5) < 0.5,
                "Footer growth while reading shifted viewport instead of compensating offset (got \(list.contentOffset.y))")

        pin.resized(by: 30.5)
        #expect(abs(list.contentOffset.y - 500) < 0.5,
                "Footer shrink while reading shifted viewport instead of compensating offset (got \(list.contentOffset.y))")

        // At newest end: compact queue bar (<= endRoom) appearing and draining keeps visual row position steady.
        list.contentOffset = CGPoint(x: 0, y: -80)
        pin.resized(by: -30.5, maxNewestGap: ChatView.endRoom)
        #expect(abs(list.contentOffset.y - (-49.5)) < 0.5,
                "Compact footer growth at newest end was not compensated (got \(list.contentOffset.y))")

        pin.resized(by: 30.5, maxNewestGap: ChatView.endRoom)
        #expect(abs(list.contentOffset.y - (-80)) < 0.5,
                "Compact footer shrink at newest end did not restore exact newest offset (got \(list.contentOffset.y))")

        // At newest end: tall footer cards (> endRoom, such as QuestionDock) do not absorb upward so they never
        // bury the newest message behind the card.
        list.contentOffset = CGPoint(x: 0, y: -80)
        pin.resized(by: -220, maxNewestGap: ChatView.endRoom)
        #expect(abs(list.contentOffset.y - (-80)) < 0.5,
                "Tall footer card at newest end must keep newest message clear above the card (got \(list.contentOffset.y))")
    }
}

@MainActor
struct NewMainChatJumpRegressionTests {
    private static let zone = TimeZone.current.identifier

    private func assistantJSON(main: String?, conversations: [[String: Any]] = []) throws -> String {
        var obj: [String: Any] = [
            "machine_id": "box",
            "launcher": "claude",
            "cwd": "/workspace",
            "conversations": conversations,
            "timezone": Self.zone,
        ]
        if let main { obj["main"] = main }
        return String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self)
    }

    private func makeModel(_ hub: FakeHub) throws -> AppModel {
        let transport = try #require(hub.client.transport)
        let model = AppModel(stateFolder: FileManager.default.temporaryDirectory.appending(path: "new-main-jump-" + UUID().uuidString))
        model.linkHooksForTests = (transport: transport, socket: { SyncSocket() })
        model.connectOnly(.demo)
        model.link("")?.received(HubHello(features: [
            MainConversationActions.compactFeature,
            MainConversationActions.newMainFeature,
            MainConversationActions.clearFeature,
        ]))
        return model
    }

    @Test func startNewMainArmsClearedMainStateInsteadOfJumpingToWelcomeHome() async throws {
        let hub = FakeHub()
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: "old-main"))
        let model = try makeModel(hub)
        await model.refreshAssistant()

        let oldMain = try #require(model.assistantMain)
        #expect(oldMain.sessionID == "old-main")
        model.assistantCurrent = oldMain

        hub.on("POST", "/api/v1/assistant/main/new", json: #"{"ok":true,"archived":"old-main","carried":true}"#)
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: nil))

        let ok = await model.startNewMain(carry: true)
        #expect(ok)
        #expect(model.assistantCurrent == nil)
        #expect(model.assistantMain == nil)
        #expect(model.mainClear.showsPage(group: model.hub?.group ?? "", manager: model.assistantManagerID ?? "",
                                          currentEmpty: model.assistantCurrent == nil,
                                          mainSessionID: model.assistantMain?.sessionID),
                "startNewMain must land on the cleared empty main page rather than flashing AssistantWelcome + ShellNeedsYou")
    }

    @Test func startNewMainOnMainChangedRoutesToHubReplacementMain() async throws {
        let hub = FakeHub()
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: "old-main"))
        let model = try makeModel(hub)
        await model.refreshAssistant()

        let oldMain = try #require(model.assistantMain)
        model.assistantCurrent = oldMain

        hub.on("POST", "/api/v1/assistant/main/new") { _ in
            throw APIError(status: 409, message: "main changed", fields: ["code": "main_changed"])
        }
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: "replacement-main"))

        let ok = await model.startNewMain(carry: false)
        #expect(ok)
        #expect(model.assistantCurrent?.sessionID == "replacement-main",
                "409 main_changed should route to the replacement main instead of leaving assistantCurrent nil")
        #expect(!model.mainClear.showsPage(group: model.hub?.group ?? "", manager: model.assistantManagerID ?? "",
                                           currentEmpty: model.assistantCurrent == nil,
                                           mainSessionID: model.assistantMain?.sessionID))
    }

    @Test func startNewMainDoesNotWipeAnOpenSideConversation() async throws {
        let hub = FakeHub()
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: "old-main"))
        let model = try makeModel(hub)
        await model.refreshAssistant()

        let side = SessionKey(machineID: "box", sessionID: "side-chat")
        model.assistantCurrent = side

        hub.on("POST", "/api/v1/assistant/main/new", json: #"{"ok":true,"archived":"old-main","carried":false}"#)
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: nil))

        let ok = await model.startNewMain(carry: false)
        #expect(ok)
        #expect(model.assistantCurrent == side,
                "startNewMain invoked while viewing a side conversation must leave that conversation open")
    }

    @Test func startNewMainBusyFailureLeavesCurrentMainAndClearStateUntouched() async throws {
        let hub = FakeHub()
        hub.on("GET", "/api/v1/assistant", json: try assistantJSON(main: "old-main"))
        let model = try makeModel(hub)
        await model.refreshAssistant()

        let oldMain = try #require(model.assistantMain)
        model.assistantCurrent = oldMain

        hub.on("POST", "/api/v1/assistant/main/new") { _ in
            throw APIError(status: 409, message: "busy", fields: ["code": "busy"])
        }

        let ok = await model.startNewMain(carry: true)
        #expect(!ok)
        #expect(model.assistantCurrent == oldMain)
        #expect(!model.mainClear.busy)
        #expect(model.mainClear.cleared == nil)
    }

    @Test func mainClearStateTreatsEmptyStringMainSessionIDAsNoMain() {
        var state = MainClearState()
        let started = state.begin(group: "hub", manager: "", sessionID: "old-main")
        #expect(started)
        state.succeed()

        #expect(state.showsPage(group: "hub", manager: "", currentEmpty: true, mainSessionID: ""),
                "Empty-string mainSessionID must be treated the same as nil")
        let dropped = state.note(group: "hub", manager: "", mainSessionID: "")
        #expect(!dropped, "Empty-string mainSessionID must not falsely drop the cleared main page")
        #expect(state.cleared != nil)
    }
}
