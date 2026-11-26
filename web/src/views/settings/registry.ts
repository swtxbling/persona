// Unified Web Settings registry (#13395, mirroring iOS #13536 SettingsCatalog in
// apple/Persona/Views/Settings/SettingsNavigation.swift): every CoreTab has exactly one home,
// Settings home shows at most CORE_SETTINGS_LIMIT (10) core rows across the three scopes
// (current assistant, this device, hub), followed by one Advanced entry and Labs on its own.
// Advanced categories stay grouped under the same three scopes inside Settings › Advanced and
// remain directly reachable by URL and Settings search.
import { enabledSettingsTabs } from "../../core/module-settings";
import { isLegacyIntegrationTab } from "./integrations-route";
import type { CoreTab, NavGroup, Tab } from "./nav";

/** Maximum number of core rows shown on Settings home (excluding the Advanced entry and Labs). */
export const CORE_SETTINGS_LIMIT = 10;

export type SettingsScope = "assistant" | "device" | "hub";
export type SettingsTier = "core" | "entry" | "advanced" | "labs";
export type SettingsNavGroup = NavGroup | "advanced";

export interface SettingsRegistryEntry {
  readonly id: CoreTab;
  readonly group: NavGroup;
  readonly tier: SettingsTier;
}

export const SETTINGS_SCOPES: readonly SettingsScope[] = ["assistant", "device", "hub"];

/** Every CoreTab listed once, in display order within its scope and tier. */
export const SETTINGS_REGISTRY: readonly SettingsRegistryEntry[] = [
  // Current assistant's settings (core: 6 legacy / 3 with integrations_v2; advanced: 3)
  { id: "models", group: "assistant", tier: "core" },
  { id: "persona", group: "assistant", tier: "core" },
  { id: "prompts", group: "assistant", tier: "advanced" },
  { id: "integrations", group: "assistant", tier: "core" },
  { id: "channels", group: "assistant", tier: "core" },
  { id: "connectors", group: "assistant", tier: "core" },
  { id: "sources", group: "assistant", tier: "core" },
  { id: "extensions", group: "assistant", tier: "core" },
  { id: "knowledge", group: "assistant", tier: "advanced" },
  { id: "agents", group: "assistant", tier: "advanced" },
  // This device (core: 2; advanced: 1; single Advanced entry: 1)
  { id: "general", group: "device", tier: "core" },
  { id: "notifications", group: "device", tier: "core" },
  { id: "shortcuts", group: "device", tier: "advanced" },
  { id: "advanced", group: "device", tier: "entry" },
  // Hub (core: 1; advanced: 3)
  { id: "hub", group: "hub", tier: "core" },
  { id: "managers", group: "hub", tier: "advanced" },
  { id: "avatar", group: "hub", tier: "advanced" },
  { id: "devices", group: "hub", tier: "advanced" },
  // Labs (1, untouched in its own untitled group)
  { id: "labs", group: "labs", tier: "labs" },
];

const ADVANCED_TABS: ReadonlySet<Tab> = new Set<Tab>(
  SETTINGS_REGISTRY.filter((e) => e.tier === "advanced").map((e) => e.id),
);

const matchesIntegrationsMode = (id: CoreTab, integrationsV2: boolean): boolean =>
  integrationsV2 ? !isLegacyIntegrationTab(id) : id !== "integrations";

/** Whether a tab is one of the categories housed under Settings › Advanced. */
export function isAdvancedTab(tab: Tab): boolean {
  return ADVANCED_TABS.has(tab);
}

/** The core rows shown on Settings home for the active integrations_v2 mode (always <= CORE_SETTINGS_LIMIT). */
export function coreTabs(integrationsV2 = false): CoreTab[] {
  return SETTINGS_REGISTRY
    .filter((e) => e.tier === "core" && matchesIntegrationsMode(e.id, integrationsV2))
    .map((e) => e.id);
}

/** Top-level Settings navigation groups: the three core scopes (<= CORE_SETTINGS_LIMIT core rows)
 *  with enabled feature modules' categories appended to their scope, then the single Advanced entry,
 *  then Labs on its own. */
export function coreNavGroups(integrationsV2 = false): { key: SettingsNavGroup; tabs: Tab[] }[] {
  const extra = enabledSettingsTabs();
  const scopes = SETTINGS_SCOPES.map((scope): { key: SettingsNavGroup; tabs: Tab[] } => {
    const core: Tab[] = SETTINGS_REGISTRY
      .filter((e) => e.group === scope && e.tier === "core" && matchesIntegrationsMode(e.id, integrationsV2))
      .map((e) => e.id);
    const modTabs = extra.filter((m) => m.group === scope).map((m) => m.key);
    return { key: scope, tabs: modTabs.length ? [...core, ...modTabs] : core };
  });
  const entryTabs: Tab[] = SETTINGS_REGISTRY.filter((e) => e.tier === "entry").map((e) => e.id);
  const labsTabs: Tab[] = [
    ...SETTINGS_REGISTRY.filter((e) => e.tier === "labs").map((e) => e.id),
    ...extra.filter((m) => m.group === "labs").map((m) => m.key),
  ];
  return [
    ...scopes,
    ...(entryTabs.length ? [{ key: "advanced" as const, tabs: entryTabs }] : []),
    ...(labsTabs.length ? [{ key: "labs" as const, tabs: labsTabs }] : []),
  ];
}

/** The categories housed under Settings › Advanced, grouped under the same three scopes. */
export function advancedNavGroups(integrationsV2 = false): { key: SettingsScope; tabs: CoreTab[] }[] {
  return SETTINGS_SCOPES.map((scope) => ({
    key: scope,
    tabs: SETTINGS_REGISTRY
      .filter((e) => e.group === scope && e.tier === "advanced" && matchesIntegrationsMode(e.id, integrationsV2))
      .map((e) => e.id),
  }));
}
