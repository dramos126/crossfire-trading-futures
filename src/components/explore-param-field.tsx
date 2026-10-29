import { TimeStepInput } from "@/components/time-step-input";
import { CALIBRATED_OFF_VALUE, isOffCalibration } from "@/lib/trading/param-explore";
import type {
  ExploreDomain,
  NumberParam,
  NumericCalibrationRange,
  ParamValue,
  SelectParam,
} from "@/lib/trading/strategy-types";

export const OFF_CALIBRATION_NOTE = "Outside the playbook's calibration — research only";
export const OFF_CALIBRATION_TITLE =
  "The playbook was measured only at its calibrated values, so a run at this one is research, not a preview of the playbook as it trades. Export settings marks the backtest command as research.";

/** The light hint under the control: the default and the measured values. */
export function describeCalibrated(param: SelectParam): string {
  return `Playbook default ${param.default} · calibrated ${param.options.map((o) => o.value).join(", ")}`;
}

/** The same hint for a number whose bounds are a calibrated range. */
export function describeCalibratedBand(param: NumberParam, band: NumericCalibrationRange): string {
  const off = band.kind === "rangeOrOff" ? `, or ${CALIBRATED_OFF_VALUE} for off` : "";
  return `Playbook default ${param.default} · calibrated ${band.min}–${band.max}${off}`;
}

/** The hint, and the research marker when the value is off the calibration. */
export function CalibrationNote({ hint, off }: { hint: string; off: boolean }) {
  return (
    <>
      <p className="mt-1 text-[11px] font-mono tabular text-[var(--muted)]">{hint}</p>
      {off && (
        <p className="mt-0.5 text-[11px] text-[var(--warning)]" title={OFF_CALIBRATION_TITLE}>
          {OFF_CALIBRATION_NOTE}
        </p>
      )}
    </>
  );
}

/**
 * A calibration-list select as a free input of its declared type, for a
 * research form only. The value stays a string, as the select's would be, so
 * the hooks read it the same way and the export writes it verbatim; a value
 * the type cannot take is refused by the form, not here.
 */
export function ExploreParamField({
  id,
  param,
  domain,
  value,
  onChange,
  readOnly,
  modified,
  inputClass,
}: {
  id: string;
  param: SelectParam;
  domain: ExploreDomain;
  value: ParamValue;
  onChange: (value: string) => void;
  readOnly?: boolean;
  modified: boolean;
  inputClass: string;
}) {
  const raw = String(value);
  return (
    <div>
      {domain.type === "time" ? (
        <TimeStepInput
          name={id}
          value={raw}
          onChange={onChange}
          readOnly={readOnly}
          ariaLabel={param.label}
          modified={modified}
        />
      ) : (
        <input
          id={id}
          className={`${inputClass} tabular font-mono`}
          type="number"
          step={domain.type === "integer" ? 1 : domain.step ?? "any"}
          min={domain.min}
          max={domain.max}
          value={raw}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <CalibrationNote hint={describeCalibrated(param)} off={isOffCalibration(param, raw)} />
    </div>
  );
}
