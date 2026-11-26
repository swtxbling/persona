// Settings › Advanced directory and desktop return bar (#13395): lists the non-core Settings
// categories under the same three scopes (current assistant, this device, hub) below Appearance
// extras, reusing the existing Group, Row and SettingsGroups components.
import { t } from "../../i18n";
import { Icon } from "../../ui/icons";
import { tabInfo, type Tab } from "./nav";
import { advancedNavGroups } from "./registry";
import { GroupAction, GroupFooter, GroupTitle, hasFooter } from "./SettingsGroups";
import { Group, Row } from "./SettingsParts";

/** Desktop bar at the top of an Advanced sub-category page so the user can return to Advanced in one click. */
export function AdvancedBackBar({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div data-settings-advanced-back className="mb-4 flex items-center gap-2 px-1">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-control px-2 text-label font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
      >
        <Icon name="chevronLeft" size={14} stroke={2} className="shrink-0" />
        <span>{t("settings-nav.back_to_advanced")}</span>
      </button>
      <span aria-hidden className="text-label text-ink-3">/</span>
      <h2 className="min-w-0 truncate text-card-title font-semibold text-ink">{label}</h2>
    </div>
  );
}

/** Directory of Advanced categories grouped under the same three scopes as Settings home. */
export function AdvancedDirectory({ shown, integrationsV2, onPick }: {
  shown: (k: Tab) => boolean;
  integrationsV2: boolean;
  onPick: (k: Tab) => void;
}) {
  return (
    <div data-settings-advanced-directory>
      {advancedNavGroups(integrationsV2).map((g) => {
        const tabs = g.tabs.filter(shown);
        if (!tabs.length) return null;
        return (
          <Group
            key={g.key}
            anchor={`advanced-${g.key}`}
            title={<GroupTitle group={g.key} />}
            right={<GroupAction group={g.key} />}
            footer={hasFooter(g.key) ? <GroupFooter group={g.key} /> : undefined}
          >
            {tabs.map((k) => {
              const info = tabInfo(k);
              return (
                <Row
                  key={k}
                  icon={info.icon}
                  label={info.label}
                  hint={info.hint}
                  anchor={`advanced-entry-${k}`}
                  onClick={() => onPick(k)}
                />
              );
            })}
          </Group>
        );
      })}
    </div>
  );
}
