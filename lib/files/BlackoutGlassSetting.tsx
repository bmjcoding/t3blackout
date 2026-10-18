// Injected by t3blackout into Settings -> Appearance -> Interface. Desktop on
// macOS only: that's the only window with a blur behind it to show through.

import type { CSSProperties } from "react";

import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import {
  DEFAULT_WINDOW_OPACITY,
  MAX_WINDOW_OPACITY,
  MIN_WINDOW_OPACITY,
  isWindowOpacity,
  setWindowOpacity,
  useWindowOpacity,
} from "../../t3blackoutGlass";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function BlackoutGlassSetting() {
  const opacity = useWindowOpacity();
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;

  const ratio = (opacity - MIN_WINDOW_OPACITY) / (MAX_WINDOW_OPACITY - MIN_WINDOW_OPACITY);
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;

  return (
    <SettingsRow
      title="Window opacity"
      description="Lower it to see a blur of what's behind the window through the sidebar and chat, like smoked glass."
      resetAction={
        opacity !== DEFAULT_WINDOW_OPACITY ? (
          <SettingResetButton
            label="window opacity"
            onClick={() => setWindowOpacity(DEFAULT_WINDOW_OPACITY)}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor="t3b-window-opacity"
          >
            {opacity}%
          </output>
          <input
            aria-label="Window opacity"
            className="settings-slider min-w-0 flex-1"
            id="t3b-window-opacity"
            max={MAX_WINDOW_OPACITY}
            min={MIN_WINDOW_OPACITY}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (isWindowOpacity(value)) setWindowOpacity(value);
            }}
            step={5}
            style={sliderStyle}
            type="range"
            value={opacity}
          />
        </div>
      }
    />
  );
}
