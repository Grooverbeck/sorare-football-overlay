/** Claims are bounded; a late owner may only release its own claim. */
export interface PlayerLoadLeases {
  claim(key: string, owner: string): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}
