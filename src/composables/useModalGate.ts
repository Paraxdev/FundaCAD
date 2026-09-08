import { onMounted, onUnmounted } from "vue";
import { popModal, pushModal } from "../ui/choice";

/** Count this component's lifetime in the app-wide modal-depth gate.
 *
 *  `depth` (stores/modals.ts) is what toolBusy() reads through isChoiceOpen(), so a
 *  global shortcut cannot fire underneath an open dialog. The imperative dialogs
 *  called pushModal()/popModal() by hand on every dismissal path: MISS one and depth
 *  never returns to zero, toolBusy() stays true forever, and every tool in the app
 *  is silently dead with no error message.
 *
 *  Mounting is the one path that cannot be missed, the dialog components are
 *  rendered with v-if, so mount == open and unmount == closed, once each, whatever
 *  route the user took.
 *
 *  Deliberately NOT baked into the shared modal chrome: two converted dialogs never
 *  gated shortcuts, and changing that is behaviour, not layout. */
export function useModalGate(): void {
  onMounted(pushModal);
  onUnmounted(popModal);
}
