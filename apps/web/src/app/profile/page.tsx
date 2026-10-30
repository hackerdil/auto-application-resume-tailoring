"use client";

import { useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, type Disclosure, type Profile, type SavedAnswer } from "@/lib/api";

type WorkMode = "remote" | "hybrid" | "onsite";
const PERIODS = ["year", "month", "week", "day", "hour"] as const;
const LEVELS = ["basic", "conversational", "professional", "fluent", "native"] as const;

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

interface FormState {
  fullName: string;
  fullNameDisclosure: Disclosure;
  email: string;
  emailDisclosure: Disclosure;
  phone: string;
  phoneDisclosure: Disclosure;
  location: string;
  locationDisclosure: Disclosure;
  links: string;
  targetRoles: string;
  excludedRoles: string;
  excludedCompanies: string;
  locations: string;
  workModes: WorkMode[];
  relocate: "" | "yes" | "no";
  compMin: string;
  compMax: string;
  currency: string;
  period: (typeof PERIODS)[number];
  noticePeriod: string;
  availableFrom: string;
  languages: string;
}

const EMPTY: FormState = {
  fullName: "",
  fullNameDisclosure: "always",
  email: "",
  emailDisclosure: "ask",
  phone: "",
  phoneDisclosure: "ask",
  location: "",
  locationDisclosure: "ask",
  links: "",
  targetRoles: "",
  excludedRoles: "",
  excludedCompanies: "",
  locations: "",
  workModes: [],
  relocate: "",
  compMin: "",
  compMax: "",
  currency: "EUR",
  period: "year",
  noticePeriod: "",
  availableFrom: "",
  languages: "",
};

function fromProfile(p: Profile): FormState {
  const c = p.preferences.compensation;
  return {
    fullName: p.fullName.value,
    fullNameDisclosure: p.fullName.disclosure,
    email: p.email?.value ?? "",
    emailDisclosure: p.email?.disclosure ?? "ask",
    phone: p.phone?.value ?? "",
    phoneDisclosure: p.phone?.disclosure ?? "ask",
    location: p.location?.value ?? "",
    locationDisclosure: p.location?.disclosure ?? "ask",
    links: p.links.map((l) => `${l.label} | ${l.url}`).join("\n"),
    targetRoles: p.preferences.targetRoles.join(", "),
    excludedRoles: p.preferences.excludedRoles.join(", "),
    excludedCompanies: p.preferences.excludedCompanies.join(", "),
    locations: p.preferences.locations.join(", "),
    workModes: p.preferences.workModes,
    relocate:
      p.preferences.willingToRelocate === null
        ? ""
        : p.preferences.willingToRelocate
          ? "yes"
          : "no",
    compMin: c?.min?.toString() ?? "",
    compMax: c?.max?.toString() ?? "",
    currency: c?.currency ?? "EUR",
    period: c?.period ?? "year",
    noticePeriod: p.noticePeriod ?? "",
    availableFrom: p.availableFrom ?? "",
    languages: p.languages.map((l) => `${l.language} | ${l.level}`).join("\n"),
  };
}

function toDraft(f: FormState) {
  const opt = (value: string, disclosure: Disclosure) =>
    value.trim() ? { value: value.trim(), disclosure } : undefined;
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return {
    fullName: { value: f.fullName.trim(), disclosure: f.fullNameDisclosure },
    email: opt(f.email, f.emailDisclosure),
    phone: opt(f.phone, f.phoneDisclosure),
    location: opt(f.location, f.locationDisclosure),
    links: lines(f.links).map((l) => {
      const [label = "", url = ""] = l.split("|").map((x) => x.trim());
      return url ? { label, url } : { label: "Link", url: label };
    }),
    preferences: {
      targetRoles: list(f.targetRoles),
      excludedRoles: list(f.excludedRoles),
      excludedCompanies: list(f.excludedCompanies),
      locations: list(f.locations),
      workModes: f.workModes,
      willingToRelocate: f.relocate === "" ? null : f.relocate === "yes",
      compensation:
        f.compMin || f.compMax
          ? {
              min: num(f.compMin),
              max: num(f.compMax),
              currency: f.currency.trim().toUpperCase(),
              period: f.period,
            }
          : null,
    },
    noticePeriod: f.noticePeriod.trim() || null,
    availableFrom: f.availableFrom || null,
    languages: lines(f.languages).map((l) => {
      const [language = "", level = "professional"] = l.split("|").map((x) => x.trim());
      return { language, level };
    }),
  };
}

function DisclosureSelect(props: {
  id: string;
  value: Disclosure;
  onChange: (d: Disclosure) => void;
}) {
  return (
    <select
      id={props.id}
      value={props.value}
      onChange={(e) => {
        props.onChange(e.target.value as Disclosure);
      }}
      aria-label="Sharing"
    >
      <option value="always">Share on applications</option>
      <option value="ask">Ask me each time</option>
      <option value="never">Never share</option>
    </select>
  );
}

export default function ProfilePage() {
  const [f, setF] = useState<FormState>(EMPTY);
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [answers, setAnswers] = useState<SavedAnswer[]>([]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }));
  };

  const loadAnswers = async () => {
    setAnswers(
      (await api<{ savedAnswers: SavedAnswer[] }>("GET", "/api/v1/saved-answers")).savedAnswers,
    );
  };

  useEffect(() => {
    (async () => {
      const { profile } = await api<{ profile: Profile | null }>("GET", "/api/v1/profile");
      if (profile) {
        setF(fromProfile(profile));
        setVersion(profile.version);
      }
      await loadAnswers();
    })().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, []);

  async function save(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const { profile } = await api<{ profile: Profile }>("PUT", "/api/v1/profile", toDraft(f));
      setVersion(profile.version);
      setStatus({ kind: "ok", text: `Saved (version ${profile.version}).` });
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  }

  const contact = (
    key: "fullName" | "email" | "phone" | "location",
    title: string,
    type = "text",
  ) => {
    const dKey = `${key}Disclosure` as const;
    return (
      <div className="row">
        <div style={{ flex: "2 1 260px" }}>
          <label htmlFor={key}>{title}</label>
          <input
            id={key}
            type={type}
            value={f[key]}
            onChange={(e) => {
              set(key, e.target.value);
            }}
            required={key === "fullName"}
          />
        </div>
        <div>
          <label htmlFor={dKey}>Sharing</label>
          <DisclosureSelect
            id={dKey}
            value={f[dKey]}
            onChange={(d) => {
              set(dKey, d);
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      <h1>Profile &amp; preferences</h1>
      <p className="lede">
        Stored encrypted on this computer.{" "}
        {version ? `Current version: ${version}.` : "Not saved yet."}
      </p>
      <Status state={status} />

      <form onSubmit={(e) => void save(e)}>
        <h2>Contact details</h2>
        <div className="card">
          {contact("fullName", "Full name")}
          {contact("email", "Email", "email")}
          {contact("phone", "Phone", "tel")}
          {contact("location", "Location")}
          <label htmlFor="links">
            Links <span className="hint">one per line: Label | https://…</span>
          </label>
          <textarea
            id="links"
            value={f.links}
            onChange={(e) => {
              set("links", e.target.value);
            }}
          />
        </div>

        <h2>Job preferences</h2>
        <div className="card">
          <div className="row">
            <div>
              <label htmlFor="targetRoles">
                Target roles <span className="hint">comma-separated</span>
              </label>
              <input
                id="targetRoles"
                value={f.targetRoles}
                onChange={(e) => {
                  set("targetRoles", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="locations">Preferred locations</label>
              <input
                id="locations"
                value={f.locations}
                onChange={(e) => {
                  set("locations", e.target.value);
                }}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="excludedRoles">Roles to exclude</label>
              <input
                id="excludedRoles"
                value={f.excludedRoles}
                onChange={(e) => {
                  set("excludedRoles", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="excludedCompanies">Companies to exclude</label>
              <input
                id="excludedCompanies"
                value={f.excludedCompanies}
                onChange={(e) => {
                  set("excludedCompanies", e.target.value);
                }}
              />
            </div>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: "12px 0" }}>
            <legend style={{ fontWeight: 600, fontSize: "0.9rem" }}>Work modes</legend>
            {(["remote", "hybrid", "onsite"] as const).map((m) => (
              <label key={m} className="check">
                <input
                  type="checkbox"
                  checked={f.workModes.includes(m)}
                  onChange={(e) => {
                    set(
                      "workModes",
                      e.target.checked ? [...f.workModes, m] : f.workModes.filter((x) => x !== m),
                    );
                  }}
                />
                {m}
              </label>
            ))}
          </fieldset>
          <div className="row">
            <div>
              <label htmlFor="relocate">Willing to relocate?</label>
              <select
                id="relocate"
                value={f.relocate}
                onChange={(e) => {
                  set("relocate", e.target.value as FormState["relocate"]);
                }}
              >
                <option value="">Not saved (ask me)</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="noticePeriod">Notice period</label>
              <input
                id="noticePeriod"
                value={f.noticePeriod}
                onChange={(e) => {
                  set("noticePeriod", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="availableFrom">Available from</label>
              <input
                id="availableFrom"
                type="date"
                value={f.availableFrom}
                onChange={(e) => {
                  set("availableFrom", e.target.value);
                }}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="compMin">Compensation min</label>
              <input
                id="compMin"
                inputMode="numeric"
                value={f.compMin}
                onChange={(e) => {
                  set("compMin", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="compMax">Compensation max</label>
              <input
                id="compMax"
                inputMode="numeric"
                value={f.compMax}
                onChange={(e) => {
                  set("compMax", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="currency">Currency</label>
              <input
                id="currency"
                maxLength={3}
                value={f.currency}
                onChange={(e) => {
                  set("currency", e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="period">Per</label>
              <select
                id="period"
                value={f.period}
                onChange={(e) => {
                  set("period", e.target.value as FormState["period"]);
                }}
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="hint">
            Compensation is used for your own filtering. It is never entered into an application
            without your confirmation.
          </p>
          <label htmlFor="languages">
            Languages <span className="hint">one per line: Language | {LEVELS.join(" / ")}</span>
          </label>
          <textarea
            id="languages"
            value={f.languages}
            onChange={(e) => {
              set("languages", e.target.value);
            }}
          />
        </div>
        <div className="actions">
          <button className="primary" type="submit">
            Save profile
          </button>
        </div>
      </form>

      <SavedAnswers answers={answers} reload={loadAnswers} setStatus={setStatus} />
    </>
  );
}

function SavedAnswers(props: {
  answers: SavedAnswer[];
  reload: () => Promise<void>;
  setStatus: (s: StatusState) => void;
}) {
  const [question, setQuestion] = useState("");
  const [value, setValue] = useState("");
  const [sensitivity, setSensitivity] = useState<SavedAnswer["sensitivity"]>("sensitive");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      props.setStatus({ kind: "ok", text: ok });
      await props.reload();
    } catch (err) {
      props.setStatus({ kind: "error", text: errorText(err) });
    }
  };
  return (
    <section aria-labelledby="answers-h">
      <h2 id="answers-h">Saved answers</h2>
      <p className="hint">
        Answers you write once and reuse, such as sponsorship or notice period. Career Agent only
        uses answers saved here; it never guesses.
      </p>
      {props.answers.length === 0 && <p className="empty">No saved answers.</p>}
      {props.answers.map((a) => (
        <div className="card" key={a.id}>
          <span className="badge">{a.sensitivity}</span>
          <p style={{ margin: "8px 0" }}>
            <strong>{a.normalizedQuestion}</strong>
          </p>
          <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{a.value}</p>
          <button
            className="danger"
            type="button"
            onClick={() =>
              void run(() => api("POST", `/api/v1/saved-answers/${a.id}/revoke`), "Answer removed.")
            }
          >
            Remove
          </button>
        </div>
      ))}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api("POST", "/api/v1/saved-answers", { question, value, sensitivity }),
            "Answer saved.",
          ).then(() => {
            setQuestion("");
            setValue("");
          });
        }}
      >
        <label htmlFor="sa-q">Question</label>
        <input
          id="sa-q"
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
          required
        />
        <label htmlFor="sa-v" style={{ marginTop: 8 }}>
          Your answer
        </label>
        <textarea
          id="sa-v"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          required
        />
        <label htmlFor="sa-s" style={{ marginTop: 8 }}>
          Sensitivity
        </label>
        <select
          id="sa-s"
          value={sensitivity}
          onChange={(e) => {
            setSensitivity(e.target.value as SavedAnswer["sensitivity"]);
          }}
        >
          <option value="none">None</option>
          <option value="personal">Personal</option>
          <option value="sensitive">Sensitive (salary, authorization, availability)</option>
          <option value="protected">Protected (demographic, health, background)</option>
        </select>
        <div className="actions">
          <button className="primary" type="submit">
            Save answer
          </button>
        </div>
      </form>
    </section>
  );
}
