export class FailSafe {
  private _maxTimes = 10
  private hitCount = 0
  private hitResetTimer: NodeJS.Timeout | undefined
  private exceededHit = false

  /*
    * Check if hit count exceed max times.
    * On exceed, it will only return once until reset.
  */
  public checkHitExceed() {
    if (this.hitResetTimer) {
      clearTimeout(this.hitResetTimer)
      this.hitResetTimer = undefined
    }
    const tempTimer = setTimeout(() => {
      this.hitResetTimer = undefined
      this.hitCount = 0
    }, 1 * 1000)
    this.hitResetTimer = tempTimer

    this.hitCount++

    // If hit count is more than max times, return true, only return true once until reset.
    if (this.hitCount >= this.maxTimes && !this.exceededHit) {
      this.exceededHit = true
      return true
    }
    return false
  }

  public resetError() {
    this.hitCount = 0
    this.exceededHit = false
  }

  public get maxTimes() {
    return this._maxTimes
  }
}
