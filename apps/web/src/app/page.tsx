import Link from "next/link";

export default function Onboarding() {
  return (
    <>
      <h1>Welcome to Career Agent</h1>
      <p className="lede">
        A local tool that helps you find relevant jobs and prepare truthful applications. You stay
        in control of every step.
      </p>

      <h2>How it works</h2>
      <ol className="steps">
        <li>
          <strong>Build your fact bank.</strong> Upload your résumé. Career Agent suggests
          individual facts and you confirm, edit, or reject each one. Only facts you confirm are
          ever used.
        </li>
        <li>
          <strong>Set your preferences.</strong> Target roles, locations, work modes, and which
          contact details may be shared.
        </li>
        <li>
          <strong>Later phases:</strong> job discovery, evidence-backed matching, tailored résumés,
          and application preparation. Nothing is ever submitted without your explicit approval of
          that specific application.
        </li>
      </ol>

      <h2>Your data and privacy</h2>
      <div className="card">
        <ul>
          <li>
            Everything runs on this computer. The app only accepts connections from this machine.
          </li>
          <li>
            Your profile, saved answers, imported résumé text, and sensitive facts are encrypted on
            disk with your own key.
          </li>
          <li>
            When AI features are enabled, the relevant job text and résumé facts are sent to the AI
            providers you configured (OpenAI, and Claude through your Claude Code login). Right now,
            résumé suggestions are rule-based and nothing leaves your machine.
          </li>
          <li>
            Career Agent never guesses answers about work authorization, salary, or demographic
            questions, and never solves CAPTCHAs or accepts terms for you.
          </li>
          <li>
            You can <a href="/api/v1/export">export everything</a> at any time. To delete all local
            data, run <code>pnpm data:delete</code>.
          </li>
        </ul>
      </div>

      <div className="actions">
        <Link className="button primary" href="/facts">
          Start: upload your résumé
        </Link>
      </div>
    </>
  );
}
