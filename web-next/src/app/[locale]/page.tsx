import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const t = useTranslations("home");
  const app = useTranslations("app");

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-6">
      <section className="w-full max-w-[520px] animate-[klaw-fade-up_0.18s_ease]">
        <div className="mb-7 text-center">
          <p className="mb-3 text-[var(--fs-ui)] text-[var(--text-mut)]">
            {app("name")}
          </p>
          <h1 className="m-0 text-[var(--fs-xl)] font-semibold tracking-normal text-[var(--text)]">
            {t("title")}
          </h1>
          <p className="mx-auto mt-3 max-w-[42ch] text-[var(--fs-ui)] text-[var(--text-mut)]">
            {t("subtitle")}
          </p>
        </div>
        <div className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg-panel)] p-4 shadow-[var(--shadow-pop)]">
          <div className="grid gap-3 text-[var(--fs-ui)] text-[var(--text-mid)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <span>Next.js</span>
              <span className="mono text-[var(--text-faint)]">App Router</span>
            </div>
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <span>UI</span>
              <span className="mono text-[var(--text-faint)]">shadcn + Tailwind</span>
            </div>
            <div className="flex items-center justify-between">
              <span>i18n</span>
              <span className="mono text-[var(--text-faint)]">next-intl</span>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button size="sm">Baseline ready</Button>
          </div>
        </div>
      </section>
    </main>
  );
}
