import type { SelectHTMLAttributes } from "react";
import type { ModelGroup, ModelOption } from "../views/modelOptions";

interface GroupedSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: string;
  groups: ModelGroup[];
  /** Options before the groups (e.g. «Nessuno», «Automatico»). */
  leading?: ModelOption[];
  /** Disabled placeholder shown when `value` is empty and no leading option has it. */
  placeholder?: string;
  onChange: (value: string) => void;
}

/** Native <select> with <optgroup>s: keyboard and screen reader behaviour come from the platform. */
export function GroupedSelect({ value, groups, leading = [], placeholder, onChange, ...rest }: GroupedSelectProps) {
  const hasEmpty = leading.some((o) => o.value === "");
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
      {value === "" && !hasEmpty && placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {leading.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
