import { Navigate, useLocation } from 'react-router';
import { legacyOperationsWorkspacePath } from '@/features/trace/state';

/** Legacy route alias; preserve its query and open Operations inside the Trace workspace. */
export function OperationsRoute() {
  const location = useLocation();
  return <Navigate to={legacyOperationsWorkspacePath(location.search, location.hash)} replace />;
}
