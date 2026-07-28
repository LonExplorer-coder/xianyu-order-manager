import type {
  BootstrapState,
} from '../core/desktop-api';
import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
  Recognizer,
} from '../core/contracts';
import type {
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import { LocalApplication } from './local-application';
import { OcrSettingsService } from './ocr-settings';
import { Preferences } from './preferences';
import { WorkspaceInUseError } from './workspace';

export class DesktopSession {
  private application?: LocalApplication;
  private state: BootstrapState = { kind: 'needs_data_directory' };

  public constructor(
    private readonly preferences: Preferences,
    private readonly recognizer: Recognizer,
    private readonly ocrSettings: OcrSettingsService,
  ) {}

  public restore(): BootstrapState {
    const dataDirectory = this.preferences.getLastDataDirectory();
    if (!dataDirectory) {
      this.state = { kind: 'needs_data_directory' };
      return this.state;
    }
    return this.open(dataDirectory, false);
  }

  public getState(): BootstrapState {
    if (this.state.kind === 'ready') {
      this.state = {
        ...this.state,
        orders: this.requireApplication().listOrders(),
      };
    }
    return this.state;
  }

  public retryDataDirectory(): BootstrapState {
    return this.restore();
  }

  public useDataDirectory(dataDirectory: string): BootstrapState {
    return this.open(dataDirectory, true);
  }

  public submitSourceScreenshot(sourcePath: string): Promise<OrderDraft> {
    return this.requireApplication()
      .submitRecognitionBatch([sourcePath])
      .then((batch) => batch.drafts[0]);
  }

  public confirmDraft(draft: OrderDraft): OriginalOrder {
    const order = this.requireApplication().confirmDraft(draft);
    this.refreshOrders();
    return order;
  }

  public listOrders(): OrderSummary[] {
    return this.requireApplication().listOrders();
  }

  public getOrder(orderId: string): OrderDetails {
    return this.requireApplication().getOrder(orderId);
  }

  public async getScreenshotDataUrl(screenshotId: string): Promise<string> {
    const screenshot = await this.requireApplication().readSourceScreenshot(screenshotId);
    return `data:${screenshot.mimeType};base64,${Buffer.from(screenshot.bytes).toString('base64')}`;
  }

  public getOcrSettings(): Promise<OcrSettingsView> {
    return this.ocrSettings.getSettings();
  }

  public saveOcrSettings(input: SaveOcrSettingsInput): Promise<OcrSettingsView> {
    return this.ocrSettings.saveSettings(input);
  }

  public removeOcrApiKey(): Promise<OcrSettingsView> {
    return this.ocrSettings.removeApiKey();
  }

  public testOcrConnection(
    input: OcrConnectionTestInput,
  ): Promise<OcrConnectionTestResult> {
    return this.ocrSettings.testConnection(input);
  }

  public close(): void {
    this.application?.close();
    this.application = undefined;
  }

  private open(dataDirectory: string, remember: boolean): BootstrapState {
    this.application?.close();
    this.application = undefined;
    const application = new LocalApplication(this.recognizer);
    try {
      application.openDataDirectory(dataDirectory);
      this.application = application;
      if (remember) this.preferences.setLastDataDirectory(dataDirectory);
      this.state = {
        kind: 'ready',
        dataDirectory,
        orders: application.listOrders(),
      };
    } catch (error) {
      application.close();
      if (error instanceof WorkspaceInUseError) {
        this.state = {
          kind: 'locked',
          dataDirectory: error.dataDirectory,
          message: error.message,
        };
      } else {
        this.state = {
          kind: 'error',
          message: error instanceof Error ? error.message : '无法打开数据目录',
        };
      }
    }
    return this.state;
  }

  private refreshOrders(): void {
    if (this.state.kind !== 'ready') return;
    this.state = {
      ...this.state,
      orders: this.requireApplication().listOrders(),
    };
  }

  private requireApplication(): LocalApplication {
    if (!this.application || this.state.kind !== 'ready') {
      throw new Error('请先选择可用的数据目录');
    }
    return this.application;
  }
}
