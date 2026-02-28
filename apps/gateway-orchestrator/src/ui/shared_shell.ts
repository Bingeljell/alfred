type UiSection = "status" | "transcripts" | "console";

function renderUiNav(current: UiSection): string {
  const links: Array<{ href: string; label: string; section: UiSection }> = [
    { href: "/ui", label: "Status", section: "status" },
    { href: "/ui/transcripts", label: "Transcripts", section: "transcripts" },
    { href: "/ui/console", label: "Console", section: "console" }
  ];

  return `<nav class="nav">
${links
  .map((link) => {
    const attrs = link.section === current ? ' aria-current="page"' : "";
    return `  <a href="${link.href}"${attrs}>${link.label}</a>`;
  })
  .join("\n")}
</nav>`;
}

export function renderUiHeader(input: {
  title: string;
  subtitle: string;
  current: UiSection;
}): string {
  return `<header>
      <h1>${input.title}</h1>
      <div class="subtitle">${input.subtitle}</div>
      ${renderUiNav(input.current)}
    </header>`;
}

