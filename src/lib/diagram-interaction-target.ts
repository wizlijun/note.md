/** Core marks opted-in diagram viewports and toolbars, including the source-mode toolbar. */
export function isDiagramInteractionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-diagram-interaction]')
}
