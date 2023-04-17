import { BigNumber } from "ethers";

// Example:
// const piecewiseFn = new UBAPiecewiseFunction<BigNumber>([
//   {
//     minRange: toBN(0),
//     maxRange: toBN(100),
//     fn: (x) => x.mul(toBN(2)),
//   },
//   {
//     minRange: toBN(100),
//     maxRange: toBN(200),
//     fn: (x) => x.mul(toBN(3)),
//   },
// ]);
// console.log(piecewiseFn.apply(toBN(50)).toString()); // <- 100
// console.log(piecewiseFn.apply(toBN(150)).toString()); // <- 450

/**
 * Defines a single piece of a piecewise function.
 */
type PiecewiseElement<Type> = {
  /**
   * The minimum range of the function (inclusive)
   */
  minRange: BigNumber;
  /**
   * The maximum range of the function (exclusive)
   */
  maxRange: BigNumber;
  /**
   * The function to apply to the range
   */
  fn: (x: BigNumber) => Type;
};

class UBAPiecewiseFunction<Type> {
  private readonly elements: PiecewiseElement<Type>[];

  /**
   * Instantiates a new piecewise function
   * @param elements The elements of the piecewise function
   */
  constructor(elements: PiecewiseElement<Type>[]) {
    this.elements = elements;
  }

  /**
   * Submits a new piecewise element to the function
   * @param element The element to add
   */
  public addElement(element: PiecewiseElement<Type>): void {
    this.elements.push(element);
  }

  /**
   * Tests that the piecewise function is valid
   * @returns True if the function is valid, false otherwise
   */
  public isValid(): boolean {
    // Check that the elements are sorted
    for (let i = 0; i < this.elements.length - 1; i++) {
      if (this.elements[i].maxRange.gt(this.elements[i + 1].minRange)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Applies the piecewise function to the given value
   * @param value The value to apply the function to
   * @returns The result of the function
   */
  public apply(value: BigNumber): Type {
    // Check that the function is valid
    if (!this.isValid()) {
      throw new Error("Piecewise function is not valid");
    }
    // Find the element that the value is in
    const element = this.elements.find((element) => {
      return value.gte(element.minRange) && value.lt(element.maxRange);
    });
    // Check that the element is defined
    if (element === undefined) {
      throw new Error("Value is not in the range of the piecewise function");
    }
    // Apply the function to the value
    return element.fn(value);
  }
}

export default UBAPiecewiseFunction;
