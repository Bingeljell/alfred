import type { Express } from "express";

type CoreRouteDeps = {
  health: () => Promise<unknown>;
  renderUiHome: () => string;
  renderUiTranscripts: () => string;
  renderUiConsole: () => string;
};

export function registerCoreRoutes(app: Express, deps: CoreRouteDeps) {
  app.get("/", (_req, res) => {
    res.redirect(302, "/ui");
  });

  app.get("/ui", (_req, res) => {
    res.status(200).type("html").send(deps.renderUiHome());
  });

  app.get("/ui/transcripts", (_req, res) => {
    res.status(200).type("html").send(deps.renderUiTranscripts());
  });

  app.get("/ui/console", (_req, res) => {
    res.status(200).type("html").send(deps.renderUiConsole());
  });

  app.get("/health", async (_req, res) => {
    const health = await deps.health();
    res.status(200).json(health);
  });
}
