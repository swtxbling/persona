// @vitest-environment jsdom
// Unified Web Settings registry guards (#13395, mirroring iOS #13536 SettingsRegistryTests):
// Settings home caps core rows at CORE_SETTINGS_LIMIT (10), every CoreTab has exactly one home,
// Settings.tsx draws top-level rows strictly from coreNavGroups(), every Advanced category is
// grouped under the three scopes, reachable by URL, and searchable in en / zh-Hans / ja, and
// Optional features stays under General (core), honoring the #13844 hub flag rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationDocument } from "../../lib/configuration/contract";
import settingsSource from "../Settings.tsx?raw";
import labsSource from "./Labs.tsx?raw";
import { moduleFeaturesSource, MODULE_FEATURES_ID } from "../../core/module-features";
import { MODULES_FEATURE, registerModule, resetModulesForTest } from "../../core/module-host";
import { forgetModuleSwitches, MODULE_SWITCH_KEY } from "../../core/module-switch";
import { getState, reset } from "../../lib/store";
import {
  advancedChildState,
  ASSISTANT_TABS,
  categoryState,
  FROM_ADVANCED,
  FROM_LIST,
  openedFromAdvanced,
  settingsAt,
  settingsHref,
  stepsToList,
  TABS,
  type CoreTab,
} from "./nav";
import {
  advancedNavGroups,
  CORE_SETTINGS_LIMIT,
  coreNavGroups,
  coreTabs,
  isAdvancedTab,
  SETTINGS_REGISTRY,
  SETTINGS_SCOPES,
} from "./registry";

const EXPECTED_ADVANCED: Record<(typeof SETTINGS_SCOPES)[number], CoreTab[]> = {
  assistant: ["prompts", "knowledge", "agents"],
  device: ["shortcuts"],
  hub: ["managers", "avatar", "devices"],
};

afterEach(() => {
  resetModulesForTest();
  localStorage.removeItem(MODULE_SWITCH_KEY);
  forgetModuleSwitches();
  reset();
});

describe("unified Web Settings registry (#13395)", () => {
  it("caps core home rows at CORE_SETTINGS_LIMIT (10) in both legacy and integrations_v2 modes", () => {
    expect(CORE_SETTINGS_LIMIT).toBe(10);
    for (const integrationsV2 of [false, true]) {
      const core = coreTabs(integrationsV2);
      expect(core.length).toBeLessThanOrEqual(CORE_SETTINGS_LIMIT);
      const homeCore = coreNavGroups(integrationsV2)
        .filter((g) => g.key !== "advanced" && g.key !== "labs")
        .flatMap((g) => g.tabs);
      expect(homeCore).toEqual(core);
      expect(homeCore.length).toBeLessThanOrEqual(CORE_SETTINGS_LIMIT);
    }
    expect(coreTabs(false)).toEqual([
      "models", "persona", "channels", "connectors", "sources", "extensions",
      "general", "notifications",
      "hub",
    ]);
    expect(coreTabs(true)).toEqual([
      "models", "persona", "integrations",
      "general", "notifications",
      "hub",
    ]);
  });

  it("lists every CoreTab exactly once with a single tier and disjoint homes", () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect([...ids].sort()).toEqual([...TABS].sort());

    const byTier = (tier: (typeof SETTINGS_REGISTRY)[number]["tier"]) =>
      SETTINGS_REGISTRY.filter((e) => e.tier === tier).map((e) => e.id);
    const core = new Set(byTier("core"));
    const entry = new Set(byTier("entry"));
    const advanced = new Set(byTier("advanced"));
    const labs = new Set(byTier("labs"));

    expect([...entry]).toEqual(["advanced"]);
    expect([...labs]).toEqual(["labs"]);
    expect(core.size + entry.size + advanced.size + labs.size).toBe(TABS.length);
    for (const id of core) {
      expect(advanced.has(id)).toBe(false);
      expect(entry.has(id)).toBe(false);
      expect(labs.has(id)).toBe(false);
    }
    // Every assistant-scoped tab (core or advanced) stays in ASSISTANT_TABS so switching assistants reloads it.
    for (const e of SETTINGS_REGISTRY.filter((x) => x.group === "assistant")) {
      expect(ASSISTANT_TABS.has(e.id), e.id).toBe(true);
    }
  });

  it("places Advanced after the three core scopes and keeps Labs on its own", () => {
    for (const integrationsV2 of [false, true]) {
      const groups = coreNavGroups(integrationsV2);
      expect(groups.map((g) => g.key)).toEqual(["assistant", "device", "hub", "advanced", "labs"]);
      expect(groups.find((g) => g.key === "advanced")!.tabs).toEqual(["advanced"]);
      expect(groups.find((g) => g.key === "labs")!.tabs).toEqual(["labs"]);
    }
  });

  it("draws top-level Settings navigation in Settings.tsx strictly from coreNavGroups()", () => {
    const source = settingsSource;
    const navStart = source.indexOf("function SettingsNav(");
    const navEnd = source.indexOf("function NavRow(");
    const listStart = source.indexOf("function SettingsList(");
    const listEnd = source.indexOf("// ── General");
    expect(navStart).toBeGreaterThan(0);
    expect(navEnd).toBeGreaterThan(navStart);
    expect(listStart).toBeGreaterThan(navEnd);
    expect(listEnd).toBeGreaterThan(listStart);

    const navBody = source.slice(navStart, navEnd);
    const listBody = source.slice(listStart, listEnd);
    expect(navBody).toContain("coreNavGroups(integrationsV2)");
    expect(navBody).not.toContain("NAV_GROUPS");
    expect(navBody).not.toContain("navGroups(");
    // NavRow is only rendered inside `.map(...)` loops over search tabs or coreNavGroups().
    expect(navBody.match(/<NavRow\b/g)?.length).toBe(2);

    expect(listBody).toContain("coreNavGroups(integrationsV2)");
    expect(listBody).not.toContain("NAV_GROUPS");
    expect(listBody).not.toContain("navGroups(");
    expect(listBody.match(/<Row\b/g)?.length).toBe(1);
  });

  it("groups all 7 Advanced categories under the same three scopes and keeps every URL round-trippable", () => {
    const groups = advancedNavGroups(false);
    expect(groups.map((g) => g.key)).toEqual(SETTINGS_SCOPES);
    for (const scope of SETTINGS_SCOPES) {
      expect(groups.find((g) => g.key === scope)!.tabs).toEqual(EXPECTED_ADVANCED[scope]);
    }
    const allAdvanced = groups.flatMap((g) => g.tabs);
    expect(allAdvanced).toHaveLength(7);
    for (const k of TABS) {
      expect(isAdvancedTab(k), k).toBe(allAdvanced.includes(k));
    }
    for (const k of allAdvanced) {
      const url = settingsHref(k, null, false);
      expect(url).toBe(`/settings?tab=${k}`);
      expect(settingsAt(url.split("?")[1] ?? "")).toEqual({ tab: k, sub: null, section: null });
    }
  });

  it.each(["en", "zh-Hans", "ja"])("finds every Advanced category directly by Settings search in %s", async (lang) => {
    vi.resetModules();
    const { initI18n } = await import("../../i18n");
    await initI18n(lang);
    const { TAB_INFO } = await import("./nav");
    const { advancedNavGroups: advGroups } = await import("./registry");
    const { searchSettings } = await import("./search");

    for (const tab of advGroups(false).flatMap((g) => g.tabs)) {
      const label = TAB_INFO[tab].label;
      const result = searchSettings(label, false);
      expect(result.tabs, `${lang}:${tab} (${label})`).toContain(tab);
      // Direct category match ranks ahead of the generic Advanced entry so Enter jumps directly to it.
      const advIdx = result.tabs.indexOf("advanced");
      if (advIdx >= 0) {
        expect(result.tabs.indexOf(tab), `${lang}:${tab} ahead of advanced`).toBeLessThan(advIdx);
      }
    }
  });

  it("keeps Optional features under General (core), never Labs, and honors the #13844 hub flag rule", async () => {
    expect(labsSource).not.toContain("moduleFeaturesSource");
    expect(labsSource).not.toContain("module-features");

    registerModule({
      id: "garden",
      feature: "module.garden",
      title: () => "Garden",
      description: () => "A synthetic optional module",
      load: async () => ({}),
    });

    const source = moduleFeaturesSource();
    expect(source).not.toBeNull();
    expect(source!.key).toBe(`general:${MODULE_FEATURES_ID}`);
    expect(coreTabs(false)).toContain("general");

    const readDoc = async () => (await source!.read()) as ConfigurationDocument;

    // Hub without MODULES_FEATURE marker: offered and writable (backward-compatible default).
    Object.assign(getState(), { features: ["terminal_stream"], loaded: true });
    const legacyDoc = await readDoc();
    expect(legacyDoc.groups[0]!.fields[0]!.id).toBe("garden");
    expect(legacyDoc.groups[0]!.fields[0]!.read_only).toBeUndefined();

    // Hub publishing MODULES_FEATURE without module.garden: shown read-only with disabled_reason.
    Object.assign(getState(), { features: [MODULES_FEATURE], loaded: true });
    const unofferedDoc = await readDoc();
    expect(unofferedDoc.groups[0]!.fields[0]).toMatchObject({ id: "garden", read_only: true });
    expect(unofferedDoc.groups[0]!.fields[0]!.disabled_reason).toBeTruthy();

    // Hub publishing MODULES_FEATURE with module.garden: offered and writable again.
    Object.assign(getState(), { features: [MODULES_FEATURE, "module.garden"], loaded: true });
    const offeredDoc = await readDoc();
    expect(offeredDoc.groups[0]!.fields[0]!.id).toBe("garden");
    expect(offeredDoc.groups[0]!.fields[0]!.read_only).toBeUndefined();
  });

  it("tracks Advanced child history state cleanly for phone and desktop Back", () => {
    expect(openedFromAdvanced(null)).toBe(false);
    expect(openedFromAdvanced({ [FROM_ADVANCED]: true })).toBe(true);
    expect(advancedChildState(null)).toEqual({ [FROM_ADVANCED]: true });
    const fromPhoneAdvanced = advancedChildState({ [FROM_LIST]: true });
    expect(fromPhoneAdvanced).toEqual({ [FROM_ADVANCED]: true, [FROM_LIST]: 2 });
    expect(stepsToList(fromPhoneAdvanced)).toBe(2);
    expect(categoryState(fromPhoneAdvanced)).toEqual({ [FROM_LIST]: 2 });
  });
});
