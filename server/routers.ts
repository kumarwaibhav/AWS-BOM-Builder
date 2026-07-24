import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { billsRouter } from "./routers/bills";

export const appRouter = router({
  system: systemRouter,
  bills: billsRouter,
});

export type AppRouter = typeof appRouter;
