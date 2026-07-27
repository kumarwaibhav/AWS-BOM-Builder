import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { SESSION_STORAGE_KEY } from "./const";
import "./index.css";

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Query Error]", event.query.state.error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Mutation Error]", event.mutation.state.error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      // Same-origin fetch already sends cookies by default in modern
      // browsers, but this is made explicit rather than relied upon --
      // the httpOnly session cookie (server/_core/sessionCookie.ts) only
      // works if it's actually sent with every request.
      fetch(url, options) {
        return fetch(url, { ...options, credentials: "include" });
      },
      // One-time bridge for pre-existing users: if this browser still has
      // the OLD localStorage sessionId from before the signed-cookie
      // migration, offer it so the server can adopt any real history under
      // it into the new cookie instead of silently orphaning it. Harmless
      // no-op once a valid new cookie already exists.
      headers() {
        const legacy =
          typeof window !== "undefined" ? localStorage.getItem(SESSION_STORAGE_KEY) : null;
        return legacy ? { "X-Legacy-Session-Id": legacy } : {};
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
