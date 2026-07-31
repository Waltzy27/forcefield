import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Analyzer from "./pages/Analyzer";
import Sessions from "./pages/Sessions";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Switch>
          <Route path="/" component={Analyzer} />
          <Route path="/sessions" component={Sessions} />
        </Switch>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}
