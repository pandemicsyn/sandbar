/** Deterministic example boundary. Replace this with a provider's authenticated native client. */
export class AcmeClient {
  static readonly boxes = new Map<
    string,
    { account: string; region: string; size: string; running: boolean }
  >();
  static creates = 0;
  static destroys = 0;
  static closes = 0;
  constructor(private readonly token: string) {}
  async whoami(): Promise<{ id: string }> {
    if (this.token !== "fixture-token") throw new Error("Invalid fixture credential");

    return { id: "account-1" };
  }
  async spawn(input: {
    account: string;
    imageId: string;
    region: string;
    size: string;
    blockAllEgress: true;
    public: false;
    requestId: string;
  }): Promise<{ id: string; ready: boolean }> {
    if (input.imageId !== "image-123") throw new Error("Unknown fixture image");
    AcmeClient.creates++;
    const id = `acme-${AcmeClient.creates}`;
    AcmeClient.boxes.set(id, {
      account: input.account,
      region: input.region,
      size: input.size,
      running: true,
    });

    return { id, ready: true };
  }
  async get(
    id: string,
    account: string,
    region: string,
  ): Promise<{ id: string; size: string; running: boolean } | null> {
    const box = AcmeClient.boxes.get(id);

    if (!box || box.account !== account || box.region !== region) return null;

    return { id, size: box.size, running: box.running };
  }
  async deleteAndWait(id: string, account: string, region: string): Promise<void> {
    const box = AcmeClient.boxes.get(id);

    if (!box || box.account !== account || box.region !== region)
      throw new Error("Sandbox scope mismatch");
    box.running = false;
    AcmeClient.destroys++;
  }
  close(): void {
    AcmeClient.closes++;
  }
}
