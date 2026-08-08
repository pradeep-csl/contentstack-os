import { useState, useEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatInput } from "../ChatInterface";
import HomeTaskSuggestions from "../components/AppShell/HomeTaskSuggestions";
import { useAuthenticatedApi } from "../AuthContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../modelSelection";
import { useDocumentTitle } from "../useDocumentTitle";
import { homePromptFromSearch } from "../homePrompt";

type HomeSearch = { prompt?: string };

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
  }),
});

// The Home page is the "new workspace" launcher. Persistent navigation (recents, favorites) lives
// in the AppShell rail, so this page focuses on a single thing: composing the first message of a
// new gadget — a centered column with a hero, the prompt composer, and a few task suggestions.
function HomePage() {
  return <HomePageContent prompt={Route.useSearch().prompt} />;
}

export function HomePageContent({ prompt }: HomeSearch) {
  useDocumentTitle("Home");

  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: previous.nonce + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi
      .listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        console.error("Failed to fetch models:", err);
        toasts.add({ title: "Couldn't load AI models", variant: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newGadget();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, {id}] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        // Open the conversation we just started.
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        console.error("Failed to create gadget:", err);
        // A retry reuses the provisional gadget while the draft contains gadget-scoped references.
        if (!attachments?.length && !capsules?.length) {
          provisionalOverseerRef.current?.stub[Symbol.dispose]();
          provisionalOverseerRef.current = null;
        }
        toasts.add({ title: "Failed to create workspace", variant: "error" });
        throw err;
      }
    },
    [ensureProvisionalGadget, navigate, toasts],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url);
    },
    [ensureProvisionalGadget],
  );

  return (
    // Flat enterprise canvas. The block is optically centred rather than top-loaded: at a typical
    // desktop height a top-anchored column left roughly the lower half of the page empty, which read
    // as truncated rather than composed.
    <div className="flex min-h-full w-full flex-col items-center justify-center px-4 py-16 sm:px-8">
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-8">
        {/* Hero */}
        <header className="text-center">
          <h1 className="text-[28px] font-semibold tracking-tight leading-tight text-kumo-default sm:text-[30px]">
            What are we working on?
          </h1>
          {/* 15px, not 14: against a 30px headline the smaller step read as a caption under a
              display line rather than its pair. */}
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-6 tracking-[-0.25px] text-kumo-subtle">
            Describe what you need. It becomes a workspace you can keep, share, and come back to.
          </p>
        </header>

        {/* Composer */}
        <ChatInput
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          surface="canvas"
          minRows={3}
          seedText={seed.text}
          seedNonce={seed.nonce}
        />

        {/* A few example work tasks to spark ideas. Picking one seeds the composer above. */}
        <HomeTaskSuggestions
          onPick={(suggestion) =>
            setSeed((prev) => ({ text: suggestion, nonce: prev.nonce + 1 }))
          }
        />
      </div>
    </div>
  );
}
