import { Suspense } from "react";
import ProximityRoom from "./components/ProximityRoom";

export default function Home() {
  return (
    <Suspense>
      <ProximityRoom />
    </Suspense>
  );
}
