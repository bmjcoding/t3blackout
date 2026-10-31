// Injected by t3blackout into Settings -> Appearance -> Interface: one switch
// per Blackout touch (t3blackoutInterface.ts). Each row carries its Settings
// search id, which settingsSearch.ts registers, so searching finds it.

import {
  BLACKOUT_INTERFACE,
  BLACKOUT_INTERFACE_KEYS,
  blackoutInterfaceSearchId,
  setBlackoutInterface,
  useBlackoutInterface,
  type BlackoutInterfaceKey,
} from "../../t3blackoutInterface";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function BlackoutInterfaceRow({ setting }: { setting: BlackoutInterfaceKey }) {
  const on = useBlackoutInterface(setting);
  const { title, description } = BLACKOUT_INTERFACE[setting];
  return (
    <SettingsRow
      {...searchableSetting(blackoutInterfaceSearchId(setting))}
      description={description}
      resetAction={
        on ? null : <SettingResetButton label={title} onClick={() => setBlackoutInterface(setting, true)} />
      }
      control={
        <Switch checked={on} onCheckedChange={(checked) => setBlackoutInterface(setting, Boolean(checked))} aria-label={title} />
      }
    />
  );
}

export function BlackoutInterfaceSettings() {
  return (
    <>
      {BLACKOUT_INTERFACE_KEYS.map((setting) => (
        <BlackoutInterfaceRow key={setting} setting={setting} />
      ))}
    </>
  );
}
