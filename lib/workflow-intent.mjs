// A planning hint, never execution authority. Recognized creation requests keep
// the governed action lane while the planner may select local coding weights.
export function isWorkflowCreationRequest(text) {
  const t=String(text??'').trim();
  if(!/^(?:please\s+)?(?:create|build|generate|render|animate|model|prepare)\b/i.test(t))return false;
  if(/\b(?:story|novel|poem|essay|email|message|poster|logo|flyer|photograph)\b/i.test(t))return false;
  return /\b(?:blender|3d\s+(?:scene|model|animation)|mesh|declarative\s+workflow)\b/i.test(t) || /\b(?:create|build|generate)\b[\s\S]{0,60}\brender\b[\s\S]{0,120}\b(?:scene|panel|object|animation)\b/i.test(t);
}
