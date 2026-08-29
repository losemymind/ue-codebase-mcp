#pragma once

#define UCLASS(...)
#define UFUNCTION(...)
#define UPROPERTY(...)
#define GENERATED_BODY()

namespace Gold {

/// A documented template used to verify stable symbol identities.
template <typename T>
class Box {
public:
  T Value{};
};

UCLASS(BlueprintType, meta = (DisplayName = "Gold Actor"))
class UGoldActor {
  GENERATED_BODY()

public:
  /// Returns the integer value unchanged.
  UFUNCTION(BlueprintCallable, Category = "Gold")
  int Overload(int Value) const;

  /// Returns the floating-point value unchanged.
  UFUNCTION(BlueprintPure, Category = "Gold")
  double Overload(double Value) const;

  UPROPERTY(BlueprintReadOnly, Category = "Gold")
  int Count = 0;
};

} // namespace Gold
