// A quiet note while the speech model downloads in the background.
import { useEffect, useState } from "preact/hooks";
import { downloadProgress, watchDownloads } from "../lib/model";

export function ModelNote({ model }: { model: string }) {
  const [p, setP] = useState(downloadProgress(model));
  useEffect(() => {
    setP(downloadProgress(model));
    return watchDownloads(() => setP(downloadProgress(model)));
  }, [model]);
  if (p === null) return null;
  return <span class="small muted" role="status" title="A one-time download, so speech can be turned into text on this computer">Getting speech-to-text ready… {Math.round(p * 100)}%</span>;
}
