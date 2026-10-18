// Injected by t3blackout into Settings -> Appearance -> Interface. Only shown
// while the Blackout theme is on screen, since only Blackout draws it.

import {
  BLACKOUT_BACKDROP_LABELS,
  DEFAULT_BLACKOUT_BACKDROP,
  isBlackoutBackdrop,
  setBlackoutBackdrop,
  useActiveThemeId,
  useBlackoutBackdrop,
} from "../../t3blackoutBackdrop";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function BlackoutBackdropSetting() {
  const themeId = useActiveThemeId();
  const backdrop = useBlackoutBackdrop();
  if (themeId !== "blackout") return null;

  return (
    <SettingsRow
      title="Background"
      description="The pattern behind the chat in the Blackout theme."
      resetAction={
        backdrop !== DEFAULT_BLACKOUT_BACKDROP ? (
          <SettingResetButton
            label="background"
            onClick={() => setBlackoutBackdrop(DEFAULT_BLACKOUT_BACKDROP)}
          />
        ) : null
      }
      control={
        <Select
          value={backdrop}
          onValueChange={(value) => {
            if (isBlackoutBackdrop(value)) setBlackoutBackdrop(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Background">
            <SelectValue>{BLACKOUT_BACKDROP_LABELS[backdrop]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(BLACKOUT_BACKDROP_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
