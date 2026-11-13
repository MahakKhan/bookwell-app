import type { ReactNode } from "react";

const CSS = `
  body { margin: 0; background: #f6f6fb; }
  .lg { max-width: 760px; margin: 0 auto; padding: 48px 20px 80px; font: 16px/1.65 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: #201f3d; }
  .lg h1 { font-size: 32px; margin: 0 0 4px; letter-spacing: -.01em; }
  .lg h2 { font-size: 20px; margin: 32px 0 6px; }
  .lg p, .lg li { color: #3b3a5c; }
  .lg .muted { color: #6c6a92; font-size: 14px; }
  .lg a { color: #5b5bd6; }
  .lg table { border-collapse: collapse; width: 100%; font-size: 14.5px; margin: 8px 0; }
  .lg th, .lg td { border: 1px solid #e1e0f5; padding: 8px 10px; text-align: left; vertical-align: top; }
  .lg th { background: #f2f1fb; }
  .lg nav { margin-bottom: 28px; font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
  .lg .card { background: #fff; border: 1px solid #e1e0f5; border-radius: 14px; padding: 18px 20px; margin: 14px 0; }
`;

export function legalConfig() {
  return {
    company: process.env.LEGAL_NAME || "Bookwell",
    email: process.env.SUPPORT_EMAIL || "",
    updated: "13 November 2026",
  };
}

export function LegalPage({ title, children, email }: { title: string; children: ReactNode; email: string }) {
  return (
    <div className="lg">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <nav>
        <a href="/support">Support</a>
        <a href="/privacy">Privacy policy</a>
        <a href="/terms">Terms of service</a>
        <a href="/security">Security</a>
        {email && <a href={`mailto:${email}`}>{email}</a>}
      </nav>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
