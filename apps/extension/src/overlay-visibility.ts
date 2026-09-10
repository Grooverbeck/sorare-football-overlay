export interface OverlayVisibilitySettings {
  enabled: boolean;
  squad: boolean;
  lineups: boolean;
}

export function overlayPage(pathname: string): 'squad' | 'lineups' | 'other' {
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  if (!segments.includes('football') || segments.includes('players')) return 'other';
  // The controls govern team overview screens, not player selection/builders.
  if (segments.includes('compose') || segments.includes('compose-team')) return 'other';
  // A Squad lineup must obey the Squad switch, not both switches at once.
  if (segments.some(segment => ['squad', 'squads', 'squad-selection'].includes(segment))) return 'squad';
  return segments.includes('lineups') ? 'lineups' : 'other';
}

export class OverlayVisibilityController {
  private initialized = false;
  private active = false;
  private pending: Partial<OverlayVisibilitySettings> = {};
  private settings: OverlayVisibilitySettings = {enabled:true,squad:true,lineups:true};

  constructor(private readonly pathname: () => string, private readonly apply: (active:boolean) => void) {}

  initialize(settings: OverlayVisibilitySettings): void {
    this.settings = {...settings, ...this.pending};
    this.pending = {};
    this.initialized = true;
    this.refresh();
  }

  update(settings: Partial<OverlayVisibilitySettings>): void {
    if (!this.initialized) this.pending = {...this.pending,...settings};
    this.settings = {...this.settings,...settings};
    this.refresh();
  }

  refresh(): void {
    if (!this.initialized) return;
    const page = overlayPage(this.pathname());
    const active = this.settings.enabled && (page === 'other' || this.settings[page]);
    if (active === this.active) return;
    this.active = active;
    this.apply(active);
  }
}
