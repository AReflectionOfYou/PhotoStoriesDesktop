// Tips for telling a photo's story. A column beside the story, not a dialog:
// it stays open while the person records and moves between photos, covering
// nothing, until they close it.

export function StoryTips({ onClose }: { onClose(): void }) {
  return (
    <aside class="tips" aria-labelledby="tips-h">
      <header class="tips-bar">
        <h2 id="tips-h">How to tell the story</h2>
        <button class="quiet small" onClick={onClose} aria-label="Close the tips">✕ Close</button>
      </header>
      <div class="tips-body stack">
        <p>Tell it as if a grandchild were sitting beside you, looking at the photo with you. They can see the picture; what they can't see is what you remember.</p>
        <h3>Start in the moment, not with the photo</h3>
        <p class="compare-tip"><span class="no">Instead of</span> “This is a photo of my mother at the lake.”</p>
        <p class="compare-tip"><span class="yes">Try</span> “Every Sunday that summer, Mom packed sandwiches and we drove out to the lake.”</p>
        <p class="compare-tip"><span class="yes">Or</span> “I'll never forget how cold that water was.”</p>
        <h3>Then, in any order</h3>
        <ul>
          <li><strong>Who's there</strong>, and how you're connected: “my mother, Rose Martinez, on the left, and her brother Joe.”</li>
          <li><strong>What was happening</strong> just before and after the picture was taken.</li>
          <li><strong>Small details</strong>: what people said, the smells, the sounds, the car you drove there in.</li>
          <li><strong>Why it matters</strong>: what it tells about them, or about you, and what you want people to know.</li>
        </ul>
        <h3>Check what's already known</h3>
        <p>Many photos carry their own date, time and location. When they do, they're already filled in under When and Where, and the names you gave the faces are listed too. Check that they're right; there's no need to say them again, unless the story behind them matters.</p>
        <h3>Don't worry about getting it perfect</h3>
        <p>Pauses, “um”s and starting over are fine. You can record more later, and the cleanup tidies the words while keeping them yours.</p>
        <p class="small muted">These tips stay open while you record and move between photos. Close them here, and bring them back with “How to tell it”.</p>
      </div>
    </aside>
  );
}
