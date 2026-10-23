import { onMounted, onUnmounted } from "vue";
import { popModal, pushModal } from "../ui/choice";

/** Holds the modal-depth gate for this component's lifetime, so global shortcuts stay off under a v-if dialog and no
 *  dismiss path can leak a pushModal(). Not in the shared modal chrome, two dialogs never gated shortcuts. */
export function useModalGate(): void {
  onMounted(pushModal);
  onUnmounted(popModal);
}
