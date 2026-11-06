/**
 * Vector icon component.
 *
 * The Android client draws chrome with Lucide `ImageVector`s plus a handful of
 * hand-written Canvas glyphs. HarmonyOS has no Lucide port and its `sys.symbol`
 * library uses different shapes, so an icon here is a raw SVG path string
 * stroked by ArkUI's `Path`.
 *
 * That keeps three properties the port needs: the geometry is the same Lucide
 * outline the Android client uses, the colour is a runtime parameter (so the
 * dark-mode tokens apply), and there is no font or image asset to ship.
 *
 * ## Why the viewport is declared in px
 *
 * ArkUI reads a path's command coordinates as **px**, not vp:
 * `PathLayoutAlgorithm::MeasureContent` takes the node's size from
 * `RSPath::GetBounds()`, and `PathPainter` strokes that same geometry, so a
 * 24-unit Lucide glyph is drawn 24 px wide on every screen density.
 *
 * `Shape` is the only thing that magnifies it. `ShapeContainerPattern`
 * `::ViewPortTransform` scales every child of a `Shape` by
 * `shapeContentSize / viewPort`, both in px, and `ShapeContainerLayoutAlgorithm`
 * takes the shape's own box as its content size once both `.width()` and
 * `.height()` are set.
 *
 * So declaring the viewport as `24px` — rather than the unitless `24`, which the
 * engine reads as vp — is what joins the two spaces: the scale becomes
 * `vp2px(iconSize) / 24`, the 24 px glyph grows to exactly `iconSize` vp, and
 * the stroke, authored in the same 24-unit space, keeps Android's proportion of
 * `strokeWidth * iconSize / 24`. No density lookup is needed, because it cancels.
 *
 * With a unitless viewport the scale collapses to `iconSize / 24` and every icon
 * renders about a screen-density too small — a 22 vp icon comes out at 6.3 vp.
 */
const ICON_FILL: string = '#00000000';

/** Lucide's authoring box, which `AA_ICONS` paths are written in. */
const VIEW_BOX: string = '24px';

@Component
export struct AAIcon {
  /** SVG path commands in 24x24 space. Multiple `M` subpaths are allowed. */
  commands: string = '';
  iconSize: number = 22;
  /**
   * `@Prop`, not a plain member: nearly every call site derives this from the
   * palette (`this.colors.ink`, usually through `withAlpha`), and the palette
   * changes without an `if` flipping, which is what re-creates a subtree. As a
   * plain member the glyph kept the colour of the theme it was born in, so icons
   * stayed dark on a page that had just turned dark.
   */
  @Prop color: string = '#000000';
  /** Stroke width in the 24-unit box; Android's Lucide glyphs use 2. */
  strokeWidth: number = 2;
  /** Lucide uses round caps and joins; keep them so the outline matches. */
  lineCap: LineCapStyle = LineCapStyle.Round;
  lineJoin: LineJoinStyle = LineJoinStyle.Round;

  build() {
    Shape() {
      Path()
        .commands(this.commands)
        .fill(ICON_FILL)
        .stroke(this.color)
        // px, like the commands above; the viewport scales both together.
        .strokeWidth(`${this.strokeWidth}px`)
        .strokeLineCap(this.lineCap)
        .strokeLineJoin(this.lineJoin)
    }
    .viewPort({ x: '0px', y: '0px', width: VIEW_BOX, height: VIEW_BOX })
    .width(this.iconSize)
    .height(this.iconSize)
  }
}
