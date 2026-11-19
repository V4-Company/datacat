import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Me {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  orgId: number;
  orgName: string;
  role: string;
}
export function useAuthUser() {
  const q = useQuery({
    queryKey: ["auth"],
    queryFn: () =>
      api<{
        user: Me | null;
        signedIn: boolean;
        restricted: boolean;
        email: string | null;
        setupRequired: boolean;
        setupTokenRequired?: boolean;
        oidc?: { enabled: boolean; label: string };
      }>("/auth/user"),
    staleTime: 60_000,
  });
  return {
    ...q,
    user: q.data?.user ?? null,
    logout: () => (window.location.href = "/api/logout?returnTo=/"),
  };
}
