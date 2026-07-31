import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function Sessions() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <Link href="/">
        <Button variant="ghost" className="gap-2 text-zinc-400 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Analyzer
        </Button>
      </Link>
      <h1 className="text-xl font-semibold">Saved Sessions</h1>
      <p className="text-zinc-500 text-sm mt-1">Session saving coming in a future update.</p>
    </div>
  );
}
