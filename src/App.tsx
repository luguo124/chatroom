import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LandingPage } from "./components/LandingPage/LandingPage";

const ChatApplication = lazy(
  () => import("./components/ChatApplication/ChatApplication"),
);

type AppView = "landing" | "chat";

function getViewFromLocation(): AppView {
  return window.location.pathname.replace(/\/$/, "") === "/chat"
    ? "chat"
    : "landing";
}

function App() {
  const [view, setView] = useState<AppView>(getViewFromLocation);

  useEffect(() => {
    const handleNavigation = () => setView(getViewFromLocation());
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  const navigateTo = (nextView: AppView) => {
    const path = nextView === "chat" ? "/chat" : "/";
    window.history.pushState({}, "", path);
    window.scrollTo({ top: 0, behavior: "smooth" });
    setView(nextView);
  };

  return (
    <ErrorBoundary>
      {view === "landing" ? (
        <LandingPage onEnterChat={() => navigateTo("chat")} />
      ) : (
        <Suspense
          fallback={
            <div className="chat-app-loading" role="status">
              <span className="landing-brand-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <p>正在打开安全空间…</p>
            </div>
          }
        >
          <ChatApplication onBackToSite={() => navigateTo("landing")} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export default App;
