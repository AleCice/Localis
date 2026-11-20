import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { CloudEmbeddingEstimate, Project } from "../../api/types";
import { LLM_SETTINGS, makeProject, makeProvider } from "../../test/fixtures";
import { CLOUD_POLICY_CONFIRM, ProjectCloudSection } from "./ProjectCloudSection";

vi.mock("../../api/client", () => ({
  api: {
    getLlmSettings: vi.fn(),
    getEmbeddingStatus: vi.fn(),
    getKeyringStatus: vi.fn(),
    listProviders: vi.fn(),
    listPrices: vi.fn(),
    setProjectCloudPolicy: vi.fn(),
    estimateCloudEmbedding: vi.fn(),
    setCloudEmbeddingConsent: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const ESTIMATE: CloudEmbeddingEstimate = {
  provider: "openai",
  model: "embed-test",
  chunks: 1234,
  chars: 456789,
  estTokens: 114198,
  estCost: { amount: 0.0023, currency: "USD" },
};

function Harness({ initial, onChange }: { initial: Project; onChange: (p: Project) => void }) {
  const [project, setProject] = useState(initial);
  return (
    <ProjectCloudSection
      project={project}
      onChange={(p) => {
        setProject(p);
        onChange(p);
      }}
    />
  );
}

function renderSection(initial: Project) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<Harness initial={initial} onChange={onChange} />);
  return { user, onChange };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.getLlmSettings.mockResolvedValue(LLM_SETTINGS);
  mockedApi.getKeyringStatus.mockResolvedValue({ available: true, message: null, detail: null });
  mockedApi.listProviders.mockResolvedValue([makeProvider("openai", { hasKey: true })]);
  mockedApi.listPrices.mockResolvedValue([]);
  mockedApi.getEmbeddingStatus.mockResolvedValue({
    state: "running",
    provider: "openai",
    model: "embed-test",
    total: 10,
    embedded: 4,
    message: null,
  });
  mockedApi.estimateCloudEmbedding.mockResolvedValue(ESTIMATE);
  mockedApi.setProjectCloudPolicy.mockImplementation(async (id, policy) =>
    makeProject("Tesi", { id, cloudPolicy: policy, cloudEmbeddingConsent: false }),
  );
  mockedApi.setCloudEmbeddingConsent.mockImplementation(async (id, consent) =>
    makeProject("Tesi", { id, cloudPolicy: "cloud_allowed", cloudEmbeddingConsent: consent }),
  );
});

describe("Uso del cloud", () => {
  it("is local-only by default; allowing the cloud asks for confirmation first", async () => {
    const project = makeProject("Tesi");
    const { user, onChange } = renderSection(project);
    const local = screen.getByRole("radio", { name: /Solo locale/ });
    const cloud = screen.getByRole("radio", { name: /Consenti cloud/ });
    expect(local).toBeChecked();

    await user.click(cloud);
    let dialog = screen.getByRole("alertdialog", { name: "Consentire il cloud per «Tesi»?" });
    expect(within(dialog).getByText(CLOUD_POLICY_CONFIRM)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Annulla" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.setProjectCloudPolicy).not.toHaveBeenCalled();
    expect(local).toBeChecked();

    await user.click(cloud);
    dialog = screen.getByRole("alertdialog", { name: "Consentire il cloud per «Tesi»?" });
    await user.click(within(dialog).getByRole("button", { name: "Consenti cloud" }));
    await waitFor(() => expect(mockedApi.setProjectCloudPolicy).toHaveBeenCalledWith(project.id, "cloud_allowed"));
    await waitFor(() => expect(cloud).toBeChecked());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cloudPolicy: "cloud_allowed" }));
  });

  it("going back to local-only needs no confirmation and says the embedding consent is revoked", async () => {
    const project = makeProject("Tesi", { cloudPolicy: "cloud_allowed", cloudEmbeddingConsent: true });
    const { user } = renderSection(project);
    await user.click(screen.getByRole("radio", { name: /Solo locale/ }));
    await waitFor(() => expect(mockedApi.setProjectCloudPolicy).toHaveBeenCalledWith(project.id, "local_only"));
    expect(await screen.findByText(/Il consenso all'indicizzazione cloud è stato revocato/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("with a cloud embedding model and a local-only project, nothing is estimated or sent", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({ ...LLM_SETTINGS, embeddingModel: { provider: "openai", model: "embed-test" } });
    renderSection(makeProject("Tesi"));
    expect(await screen.findByRole("heading", { name: "Indicizzazione cloud" })).toBeInTheDocument();
    expect(screen.getByText(/i suoi passaggi non vengono inviati e la ricerca resta lessicale/)).toBeInTheDocument();
    expect(mockedApi.estimateCloudEmbedding).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Consenti indicizzazione cloud/ })).not.toBeInTheDocument();
  });

  it("asks explicit consent for cloud indexing, showing provider, host, what is sent and the estimate", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({ ...LLM_SETTINGS, embeddingModel: { provider: "openai", model: "embed-test" } });
    const project = makeProject("Tesi", { cloudPolicy: "cloud_allowed" });
    const { user } = renderSection(project);
    expect(await screen.findByText(/Da indicizzare: 1\.?234 passaggi · 456\.789 caratteri · circa 114\.198 token \(stima\) · costo stimato 0,0023/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI · embed-test \(api\.openai\.com\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Consenti indicizzazione cloud…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Indicizzare «Tesi» con OpenAI?" });
    expect(within(dialog).getByRole("button", { name: "Annulla" })).toHaveFocus();
    expect(within(dialog).getByText("OpenAI · api.openai.com")).toBeInTheDocument();
    expect(within(dialog).getByText("embed-test")).toBeInTheDocument();
    expect(within(dialog).getByText(/Il testo dei passaggi estratti dai documenti di questo progetto/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1\.?234 passaggi/)).toBeInTheDocument();
    expect(mockedApi.setCloudEmbeddingConsent).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Consenti e invia a OpenAI" }));
    await waitFor(() => expect(mockedApi.setCloudEmbeddingConsent).toHaveBeenCalledWith(project.id, true));
    expect(await screen.findByText(/Consenso dato: i passaggi di questo progetto vengono indicizzati con OpenAI/)).toBeInTheDocument();
    expect(await screen.findByText(/Indicizzazione: In corso · 4 di 10 passaggi/)).toBeInTheDocument();
  });

  it("states «non stimabile» without a price", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({ ...LLM_SETTINGS, embeddingModel: { provider: "openai", model: "embed-test" } });
    mockedApi.estimateCloudEmbedding.mockResolvedValue({ ...ESTIMATE, estCost: null });
    renderSection(makeProject("Tesi", { cloudPolicy: "cloud_allowed" }));
    expect(await screen.findByText(/Costo non stimabile: imposta il prezzo in Impostazioni/)).toBeInTheDocument();
  });

  it("revokes the consent", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({ ...LLM_SETTINGS, embeddingModel: { provider: "openai", model: "embed-test" } });
    const project = makeProject("Tesi", { cloudPolicy: "cloud_allowed", cloudEmbeddingConsent: true });
    const { user } = renderSection(project);
    await user.click(await screen.findByRole("button", { name: "Revoca consenso" }));
    await waitFor(() => expect(mockedApi.setCloudEmbeddingConsent).toHaveBeenCalledWith(project.id, false));
    expect(await screen.findByText(/Consenso revocato: i passaggi di «Tesi» non vengono più inviati a OpenAI/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Consenti indicizzazione cloud…" })).toBeInTheDocument();
  });
});
