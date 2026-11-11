import { Link } from "wouter";
import { Bot, MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ARIA_EXAMPLE_PROMPTS, ariaPromptHref } from "@/lib/executive-assistant";

/** Example prompts that open the Aria page with the prompt pre-filled (not sent). */
export function AskAriaCard() {
  return (
    <Card data-testid="assistant-ask-aria">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5 text-red-600" aria-hidden="true" /> Ask Aria
        </CardTitle>
        <p className="text-sm text-gray-500">
          Aria can brief you, keep your to-do list, check leads waiting for a call, research a lead, and find new prospects.
          Nothing is sent to customers without your review.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {ARIA_EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <Link
                href={ariaPromptHref(prompt)}
                className="flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-gray-800 hover:border-red-200 hover:bg-red-50"
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                “{prompt}”
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
