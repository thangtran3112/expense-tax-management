import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
};

export default function PrivacyPage() {
  return (
    <main className="auth">
      <article className="auth-card">
        <h1>Privacy</h1>
        <p>ExpenseTax Capture is a private family app, not a public product.</p>
        <p>
          Receipts and expense data you capture here are stored on the family VPS and used only to
          run this app -- extracting, categorizing, and reporting your own expenses.
        </p>
        <p>Sign-in is handled through Clerk, including sign-in with Google.</p>
        <p>Nothing you capture is sold or shared with any third party.</p>
        <p>
          Questions? Contact <a href="mailto:thangtran3112@gmail.com">thangtran3112@gmail.com</a>.
        </p>
      </article>
    </main>
  );
}
